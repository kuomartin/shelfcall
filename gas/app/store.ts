// 同步的儲存實作。
//
// lock 只保護記帳：seq、異動紀錄與借閱紀錄下一個可寫的列、近期紀錄、已見過的 scanId、每冊最新的 seq、每冊最近一次借閱
// （都在 Properties／CacheService）。寫進 Sheet 的動作在放開 lock 之後進行：每次同步在 lock 內預留不重疊的列範圍，各自寫入不會互相覆蓋。
// lock 內若讀寫 Sheet，一次要持有約 1 秒以上，幾台入口同時同步就會排隊等到逾時。
//
// 已見過的 scanId 存在 CacheService：快取被清掉後重送的異動可能多寫一列。重複的異動結果相同，所以接受。
// 每冊最近一次借閱存在 Script Properties：借閱可能開好幾週，CacheService 最多 6 小時。

import {
  bookIndex,
  BORROWER_FIELD,
  LOAN_CLASS_FIELD,
  LOANED_AT_FIELD,
  LOCATION_FIELD,
  STATUS_FIELD,
  statusOf,
  text,
  TITLE_FIELD,
  UPDATED_FIELD,
  type Table,
} from "../../core/books.ts";
import {
  actionOf,
  describeState,
  type BookStore,
  type Entry,
  type LoanOp,
  type LoanRecord,
  type LoanStore,
  type LogEntry,
  type LogStore,
} from "../../core/sync.ts";
import {
  booksSheet,
  columnName,
  DATE_FORMAT,
  DATETIME_FORMAT,
  ensureLoanSheet,
  ensureLogSheet,
  LOAN_HEADERS,
  LOG_HEADERS,
  LOG_SHEET,
} from "./sheets.ts";

const CACHE_TTL_S = 21_600;
const RECENT_LIMIT = 300;
const RECENT_KEY = "changes";
const SEQ_KEY = "seq";
const LOG_ROW_KEY = "logRow";
const LOAN_ROW_KEY = "loanRow";
const LOAN_PREFIX = "loan:";
const UNDO_NOTE = "刷錯復原";
const scanKey = (scanId: string) => `scan:${scanId}`;
const stateKey = (code: string) => `state:${code}`;
const loanKey = (code: string) => `${LOAN_PREFIX}${code}`;

/** 近期紀錄多存一個 loggedAt（伺服器在 lock 內記帳的時間），給 catalogSeq 判斷哪些異動可能還沒寫進 Books。 */
type RecentEntry = Entry & { loggedAt?: number };

/** 借閱記帳多存預留的列號：借閱那一列還沒寫進去就被歸還時，靠它找到那一列。 */
type StoredLoan = LoanRecord & { row: number };

function toEntry({ loggedAt: _, ...entry }: RecentEntry): Entry {
  return entry;
}

function readLogTail(): RecentEntry[] {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const first = Math.max(2, sheet.getLastRow() - RECENT_LIMIT + 1);
  const entries: RecentEntry[] = [];
  for (const r of sheet.getRange(first, 1, sheet.getLastRow() - first + 1, LOG_HEADERS.length).getValues()) {
    const seq = Number(r[0]);
    if (!Number.isFinite(seq) || seq <= 0) continue;
    const at = r[2] instanceof Date ? r[2].getTime() : Number(r[2]);
    entries.push({ seq, scanId: String(r[1]), at, code: text(r[3]), to: { location: text(r[7]), loanClass: text(r[8]), borrower: text(r[9]) } });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export interface Reservation {
  row: number;
  entries: LogEntry[];
}

/** 放開 lock 後要寫進借閱紀錄的動作；open 已經分配好列號。 */
export type LoanWrite = (LoanOp & { kind: "open"; row: number }) | (LoanOp & { kind: "close" | "reopen"; row: number | null });

/** 必須在 script lock 內建立與使用，最後呼叫 flush；寫 Sheet 交給 writeReservation、writeLoans、writeStates。 */
export class LockedStore implements LogStore, LoanStore {
  reservation: Reservation | null = null;
  loanWrites: LoanWrite[] = [];
  #props = PropertiesService.getScriptProperties();
  #cache = CacheService.getScriptCache();
  #recent: RecentEntry[];
  #seq: number;
  #stored: Record<string, string>;
  #cached: Record<string, string>;
  #toStore: Record<string, string> = {};
  #toCache: Record<string, string> = {};

  /** lock 內每次 Properties／Cache 呼叫約 50 ms，所以一次讀齊、一次寫回。 */
  constructor(scanIds: string[]) {
    this.#stored = this.#props.getProperties();
    this.#cached = this.#cache.getAll([RECENT_KEY, ...scanIds.map(scanKey)]);
    const recent = this.#cached[RECENT_KEY];
    // 快取被清掉時，從異動紀錄的最後幾列重建。
    this.#recent = recent ? (JSON.parse(recent) as RecentEntry[]) : readLogTail();
    const stored = Number(this.#stored[SEQ_KEY] ?? 0);
    this.#seq = this.#recent.reduce((max, e) => Math.max(max, e.seq), stored);
  }

  knownScanIds(ids: string[]): Set<string> {
    const recent = new Set(this.#recent.map((e) => e.scanId));
    return new Set(ids.filter((id) => this.#cached[scanKey(id)] || recent.has(id)));
  }

  lastSeq(): number {
    return this.#seq;
  }

  append(entries: LogEntry[]): void {
    const row = Number(this.#stored[LOG_ROW_KEY] ?? 0) || ensureLogSheet().getLastRow() + 1;
    this.reservation = { row, entries };
    this.#seq = entries.reduce((max, e) => Math.max(max, e.seq), this.#seq);
    this.#toStore[SEQ_KEY] = String(this.#seq);
    this.#toStore[LOG_ROW_KEY] = String(row + entries.length);

    const loggedAt = Date.now();
    this.#recent = [...this.#recent, ...entries.map(({ seq, scanId, code, at, to }) => ({ seq, scanId, code, at, to, loggedAt }))].slice(-RECENT_LIMIT);
    this.#toCache[RECENT_KEY] = JSON.stringify(this.#recent);
    // entries 依 seq 排序，同一冊的後一筆覆蓋前一筆。
    for (const e of entries) {
      this.#toCache[stateKey(e.code)] = String(e.seq);
      this.#toCache[scanKey(e.scanId)] = "1";
    }
  }

  #loan(code: string): StoredLoan | undefined {
    const stored = this.#toStore[loanKey(code)] ?? this.#stored[loanKey(code)];
    return stored ? (JSON.parse(stored) as StoredLoan) : undefined;
  }

  record(code: string): LoanRecord | undefined {
    return this.#loan(code);
  }

  commit(ops: LoanOp[], records: Map<string, LoanRecord>): void {
    let next = Number(this.#stored[LOAN_ROW_KEY] ?? 0) || 0;
    const rows = new Map<string, number>();
    for (const op of ops) {
      if (op.kind === "open") {
        if (!next) next = ensureLoanSheet().getLastRow() + 1;
        rows.set(op.id, next);
        this.loanWrites.push({ ...op, row: next++ });
      } else {
        const known = op.id === null ? undefined : (rows.get(op.id) ?? (this.#loan(op.code)?.id === op.id ? this.#loan(op.code)?.row : undefined));
        this.loanWrites.push({ ...op, row: known ?? null });
      }
    }
    if (next) this.#toStore[LOAN_ROW_KEY] = String(next);
    for (const [code, rec] of records) {
      const row = rows.get(rec.id) ?? this.#loan(code)?.row ?? 0;
      this.#toStore[loanKey(code)] = JSON.stringify({ ...rec, row } satisfies StoredLoan);
    }
  }

  flush(): void {
    if (Object.keys(this.#toStore).length) this.#props.setProperties(this.#toStore);
    if (Object.keys(this.#toCache).length) this.#cache.putAll(this.#toCache, CACHE_TTL_S);
  }

  /** 只涵蓋最近 300 筆；更早的 cursor（例如剛開頁的裝置）拿到的就是這 300 筆。 */
  since(cursor: number): Entry[] {
    return this.#recent.filter((e) => e.seq > cursor).map(toEntry);
  }
}

/** 收集每冊的新狀態，放開 lock 後由 writeStates 寫入。 */
export class DeferredBookStore implements BookStore {
  readonly entries: LogEntry[] = [];

  setState(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  lock.waitLock(20_000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * 寫入預留的列。預留範圍不是空的（有人手動插入或刪除了列，計數器跟實際不符），
 * 就改在 lock 內接在最後一列之後寫，並校正計數器。回傳實際寫入的第一列。
 */
function writeRows(sheet: GoogleAppsScript.Spreadsheet.Sheet, row: number, rows: unknown[][], counter: string): number {
  const target = sheet.getRange(row, 1, rows.length, rows[0].length);
  if (target.getValues().every((r) => r.every((v) => v === ""))) {
    target.setValues(rows);
    return row;
  }
  return withLock(() => {
    const at = sheet.getLastRow() + 1;
    sheet.getRange(at, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();
    const props = PropertiesService.getScriptProperties();
    props.setProperty(counter, String(Math.max(at + rows.length, Number(props.getProperty(counter) ?? 0))));
    return at;
  });
}

function titles(books: Table): (code: string) => unknown {
  const index = bookIndex(books);
  const col = books.headers.indexOf(TITLE_FIELD);
  return (code) => books.rows[index.get(code) ?? -1]?.[col] ?? "";
}

export function writeReservation(reservation: Reservation | null, books: Table): void {
  if (!reservation) return;
  const title = titles(books);
  const rows = reservation.entries.map((e) => [
    e.seq,
    e.scanId,
    new Date(e.at),
    e.code,
    title(e.code),
    actionOf(e),
    describeState(e.from),
    e.to.location,
    e.to.loanClass,
    e.to.borrower,
    e.deviceId,
  ]);
  writeRows(ensureLogSheet(), reservation.row, rows, LOG_ROW_KEY);
}

const ID = 0;
const CODE = 1;
const RETURNED = 6;

/**
 * 寫借閱紀錄。新借閱寫在預留的列，只寫借閱編號到借閱日期，不碰歸還日期與備註：
 * 另一次同步可能已經先把歸還寫進同一列（借閱那一批還沒寫完就被歸還）。
 * 歸還與復原歸還依借閱編號找列；找不到時用預留的列號（那一列還沒寫進去），沒有借閱編號的依主條碼找還沒歸還的最後一列。
 */
export function writeLoans(writes: LoanWrite[], books: Table): void {
  if (!writes.length) return;
  const sheet = ensureLoanSheet();
  const title = titles(books);
  const opens = writes.filter((w) => w.kind === "open");
  const moved = new Map<string, number>();
  if (opens.length) {
    const rows = opens.map((o) => [o.id, o.code, title(o.code), o.loanClass, o.borrower, new Date(o.at)]);
    const first = writeRows(sheet, opens[0].row, rows, LOAN_ROW_KEY);
    opens.forEach((o, i) => moved.set(o.id, first + i));
  }

  const updates = writes.filter((w) => w.kind !== "open");
  if (!updates.length) return;
  const last = sheet.getLastRow();
  const values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, LOAN_HEADERS.length).getValues();
  const rowOf = (w: LoanWrite): number | null => {
    if (w.id === null) {
      for (let i = values.length - 1; i >= 0; i--) if (text(values[i][CODE]) === w.code && values[i][RETURNED] === "") return i + 2;
      return null;
    }
    if (moved.has(w.id)) return moved.get(w.id)!;
    const i = values.findIndex((r) => text(r[ID]) === w.id);
    if (i !== -1) return i + 2;
    return w.row !== null && text(values[w.row - 2]?.[ID]) === "" ? w.row : null;
  };
  for (const w of updates) {
    const row = rowOf(w);
    if (row === null) continue;
    const cells = w.kind === "close" ? [new Date(w.at), w.undo ? UNDO_NOTE : ""] : ["", ""];
    sheet.getRange(row, RETURNED + 1, 1, 2).setValues([cells]);
    if (w.kind === "close" && values[row - 2]) values[row - 2][RETURNED] = cells[0];
  }
}

/** 借閱日期只記到日：Books 依值分組寫入，同一天的借閱可以一次寫完。Apps Script 的 Date 以專案時區計算。 */
function day(at: number): Date {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 寫 Books 的位置、借閱欄、狀態與更新時間。寫入前比對快取裡每冊最新的 seq：另一次同步已經記下更新的異動，這筆就不寫，
 * 免得兩批放開 lock 後的寫入順序顛倒，讓舊的狀態蓋掉新的。比對與寫入之間仍有極小的空窗，接受。
 * 每一欄依值分組，用 RangeList 一次寫一組，不逐格呼叫，也不整列覆寫人正在編輯的其他欄。
 */
export function writeStates(entries: LogEntry[], books: Table): void {
  if (!entries.length) return;
  const latest = CacheService.getScriptCache().getAll(entries.map((e) => stateKey(e.code)));
  const current = entries.filter((e) => Number(latest[stateKey(e.code)] ?? 0) <= e.seq);
  const index = bookIndex(books);
  const col = (field: string) => (books.headers.includes(field) ? columnName(books.headers.indexOf(field) + 1) : null);
  const now = new Date();
  const fields: [field: string, value: (e: LogEntry) => string | Date, format?: string][] = [
    [LOCATION_FIELD, (e) => e.to.location],
    [LOAN_CLASS_FIELD, (e) => e.to.loanClass],
    [BORROWER_FIELD, (e) => e.to.borrower],
    [LOANED_AT_FIELD, (e) => (e.to.borrower ? day(e.at) : ""), DATE_FORMAT],
    [STATUS_FIELD, (e) => statusOf(e.to.location)],
    [UPDATED_FIELD, () => now, DATETIME_FORMAT],
  ];

  const rows = current.flatMap((e) => (index.has(e.code) ? [{ e, row: index.get(e.code)! + 2 }] : []));
  if (!rows.length) return;
  const sheet = booksSheet();
  for (const [field, value, format] of fields) {
    const c = col(field);
    if (!c) continue;
    const groups = new Map<string, { value: string | Date; cells: string[] }>();
    for (const { e, row } of rows) {
      const v = value(e);
      const key = v instanceof Date ? `d${v.getTime()}` : `s${v}`;
      const group = groups.get(key) ?? { value: v, cells: [] };
      group.cells.push(`${c}${row}`);
      groups.set(key, group);
    }
    for (const { value: v, cells } of groups.values()) {
      const list = sheet.getRangeList(cells).setValue(v);
      if (format && v instanceof Date) list.setNumberFormat(format);
    }
  }
}

/**
 * 書目快取的 seq：這個 seq 以前的異動，掃描頁視為已經寫進 Books。
 * 一分鐘內記帳的異動可能還沒寫完（寫入在放開 lock 之後），所以退到它們之前，讓掃描頁再套一次。
 * 再套一次的代價只是蓋掉這一分鐘內對同一冊的手動修改。
 */
export function catalogSeq(): number {
  const stored = Number(PropertiesService.getScriptProperties().getProperty(SEQ_KEY) ?? 0);
  const recent = CacheService.getScriptCache().get(RECENT_KEY);
  if (!recent) return stored;
  const since = Date.now() - 60_000;
  const unsure = (JSON.parse(recent) as RecentEntry[]).filter((e) => (e.loggedAt ?? 0) > since);
  return unsure.length ? Math.min(stored, ...unsure.map((e) => e.seq - 1)) : stored;
}

/**
 * 只給端到端測試用：清空異動紀錄、借閱紀錄與借閱記帳。Books 不動。
 * seq 不歸零：快取裡每冊最新的 seq 還在，歸零後新的異動會被 writeStates 當成舊的而不寫。
 */
export function resetLog(): void {
  withLock(() => {
    for (const sheet of [ensureLogSheet(), ensureLoanSheet()]) {
      if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).clearContent();
    }
    SpreadsheetApp.flush();
    const props = PropertiesService.getScriptProperties();
    for (const key of props.getKeys()) if (key.startsWith(LOAN_PREFIX)) props.deleteProperty(key);
    props.setProperties({ [LOG_ROW_KEY]: "2", [LOAN_ROW_KEY]: "2" });
    CacheService.getScriptCache().put(RECENT_KEY, "[]", CACHE_TTL_S);
  });
}
