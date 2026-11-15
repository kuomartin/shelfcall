// 同步的伺服器端邏輯：去重、分配 seq、寫入異動紀錄、決定每冊的新狀態與借閱紀錄的增改、回傳 cursor 之後的異動。
// 儲存透過 LogStore／LoanStore／BookStore 三個 port，Apps Script 端以 Sheet 實作，測試以記憶體實作。

import { ON_LOAN } from "./books.ts";

/** 一冊的狀態。借閱中時 location 是「借出中」，loanClass 與 borrower 有值；否則兩者為空字串。 */
export interface State {
  location: string;
  loanClass: string;
  borrower: string;
}

export function place(location: string): State {
  return { location, loanClass: "", borrower: "" };
}

export function loan(loanClass: string, borrower: string): State {
  return { location: ON_LOAN, loanClass, borrower };
}

export function sameState(a: State, b: State): boolean {
  return a.location === b.location && a.loanClass === b.loanClass && a.borrower === b.borrower;
}

/** 給人看的狀態：借閱中是「班級 姓名」，否則是位置。 */
export function describeState(s: State): string {
  return s.borrower ? `${s.loanClass} ${s.borrower}` : s.location || "（空白）";
}

/** 一筆異動，由掃描頁產生。scanId 重送時不變，讓寫入冪等；借閱時也是借閱編號。 */
export interface Change {
  scanId: string;
  code: string;
  /** 掃描頁刷書當下看到的狀態。 */
  from: State;
  to: State;
  /** epoch ms，以裝置時間為準。 */
  at: number;
  /** 復原掃描頁上的前一筆異動。 */
  undo: boolean;
}

/** 異動紀錄的「動作」欄。from 是掃描頁當下看到的狀態。 */
export function actionOf(c: Change): string {
  if (c.undo) return "復原";
  if (c.from.borrower && c.to.borrower) return "換人借閱";
  if (c.to.borrower) return "借閱";
  if (c.from.borrower) return "歸還";
  return "調動";
}

/** 異動紀錄的一列。seq 單調遞增，是同步 cursor，也決定同一冊多筆異動的先後。 */
export interface LogEntry extends Change {
  seq: number;
  deviceId: string;
}

/** 同步回應裡的異動：掃描頁只需要每冊變成什麼狀態。 */
export interface Entry {
  seq: number;
  scanId: string;
  code: string;
  at: number;
  to: State;
}

export interface SyncRequest {
  deviceId: string;
  /** 這台裝置已經看過的最大 seq。 */
  cursor: number;
  changes: Change[];
}

export interface SyncResponse {
  cursor: number;
  /** 本次請求中已確定落地的 scanId，含先前已寫入的重送。前端據此移出佇列。 */
  acked: string[];
  /** cursor 之後的異動，含本次送出的：掃描頁要知道自己那幾筆的 seq，才能和其他入口的異動排序。 */
  entries: Entry[];
}

/** 一冊最近一次借閱。歸還後仍保留，復原歸還時才找得到原本那一列。 */
export interface LoanRecord {
  id: string;
  loanClass: string;
  borrower: string;
  open: boolean;
}

export type LoanOp =
  | { kind: "open"; id: string; code: string; loanClass: string; borrower: string; at: number }
  /** id 為 null：這冊沒有借閱的記帳（例如導入前就借出），寫入時依主條碼找還沒歸還的那一列。 */
  | { kind: "close"; id: string | null; code: string; at: number; undo: boolean }
  /** 復原歸還：清掉原本那一列的歸還日期，不另開一列。 */
  | { kind: "reopen"; id: string; code: string };

export interface LogStore {
  knownScanIds(ids: string[]): Set<string>;
  lastSeq(): number;
  append(entries: LogEntry[]): void;
  since(cursor: number): Entry[];
}

export interface LoanStore {
  record(code: string): LoanRecord | undefined;
  /** ops 依 seq 排序；records 是這批異動之後每冊的借閱記帳。 */
  commit(ops: LoanOp[], records: Map<string, LoanRecord>): void;
}

export interface BookStore {
  /** 每冊只會收到本批 seq 最大的那一筆。 */
  setState(entry: LogEntry): void;
}

/**
 * 依異動決定借閱紀錄的增改。以伺服器的借閱記帳為準，不以掃描頁送來的 from 為準：
 * 兩台裝置同時刷同一冊時，from 可能已經過時。
 */
export function loanOps(entries: readonly LogEntry[], record: (code: string) => LoanRecord | undefined): {
  ops: LoanOp[];
  records: Map<string, LoanRecord>;
} {
  const records = new Map<string, LoanRecord>();
  const ops: LoanOp[] = [];
  for (const e of entries) {
    const rec = records.has(e.code) ? records.get(e.code) : record(e.code);
    const { loanClass, borrower } = e.to;
    const matches = rec !== undefined && rec.loanClass === loanClass && rec.borrower === borrower;
    if (e.undo && borrower && rec && !rec.open && matches) {
      ops.push({ kind: "reopen", id: rec.id, code: e.code });
      records.set(e.code, { ...rec, open: true });
      continue;
    }
    if (rec?.open && borrower && matches) continue;
    if (rec?.open) {
      ops.push({ kind: "close", id: rec.id, code: e.code, at: e.at, undo: e.undo });
      records.set(e.code, { ...rec, open: false });
    } else if (!rec && e.from.borrower) {
      ops.push({ kind: "close", id: null, code: e.code, at: e.at, undo: e.undo });
    }
    if (borrower) {
      ops.push({ kind: "open", id: e.scanId, code: e.code, loanClass, borrower, at: e.at });
      records.set(e.code, { id: e.scanId, loanClass, borrower, open: true });
    }
  }
  return { ops, records };
}

/** 呼叫端負責在呼叫期間持有寫入 lock。 */
export function applySync(log: LogStore, loans: LoanStore, books: BookStore, req: SyncRequest): SyncResponse {
  const known = log.knownScanIds(req.changes.map((c) => c.scanId));
  const fresh: LogEntry[] = [];
  let seq = log.lastSeq();
  for (const change of req.changes) {
    if (known.has(change.scanId)) continue;
    known.add(change.scanId);
    fresh.push({ ...change, seq: ++seq, deviceId: req.deviceId });
  }
  if (fresh.length) {
    log.append(fresh);
    const { ops, records } = loanOps(fresh, (code) => loans.record(code));
    loans.commit(ops, records);
  }

  const latest = new Map<string, LogEntry>();
  for (const entry of fresh) latest.set(entry.code, entry);
  for (const entry of latest.values()) books.setState(entry);

  return {
    cursor: seq,
    acked: req.changes.map((c) => c.scanId),
    entries: log.since(req.cursor),
  };
}
