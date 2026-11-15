// 掃描端的狀態：每冊目前的狀態、刷書判定、待送佇列、cursor、連線判定。
// 不碰網路、計時器與 DOM；由 web 層決定何時 request()、把回應交給 receive()。

import type { Catalog } from "./books.ts";
import { sameState, type Change, type Entry, type State, type SyncRequest, type SyncResponse } from "./sync.ts";

export class SyncClient {
  readonly deviceId: string;
  #queue: Change[] = [];
  #cursor = 0;
  #entries = new Map<string, Entry>();

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  enqueue(change: Change): void {
    this.#queue.push(change);
  }

  pending(): readonly Change[] {
    return this.#queue;
  }

  /** 伺服器回傳的異動，依 seq 排序。 */
  entries(): Entry[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
  }

  /** 送出整個佇列；回應前新進的異動留到下一次。 */
  request(): SyncRequest {
    return { deviceId: this.deviceId, cursor: this.#cursor, changes: [...this.#queue] };
  }

  receive(res: SyncResponse): void {
    const acked = new Set(res.acked);
    this.#queue = this.#queue.filter((c) => !acked.has(c.scanId));
    for (const entry of res.entries) this.#entries.set(entry.scanId, entry);
    this.#cursor = Math.max(this.#cursor, res.cursor);
  }
}

export type Outcome =
  | { kind: "unknown"; code: string }
  | { kind: "here"; code: string; title: string; state: State }
  | { kind: "change"; title: string; change: Change }
  /** 復原時，這冊已經又被刷到別處，不是當初刷成的狀態。 */
  | { kind: "changed-since"; code: string; title: string; state: State };

export interface NewChange {
  scanId: string;
  at: number;
}

/** 一筆借閱中的書，給本班借閱清單用。 */
export interface OpenLoan {
  code: string;
  title: string;
  borrower: string;
  /** epoch ms；導入前就借出、試算表上沒有借閱日期時為 0。 */
  at: number;
}

interface Known {
  state: State;
  /** 借閱中時的借閱時間。 */
  at: number;
}

/**
 * 每冊目前的狀態：書目快取的狀態，套上 seq 大於快取 seq 的異動，再套上還沒送出的異動。
 * 快取 seq 以前的異動已經寫進 Books，再套一次會蓋掉之後在試算表上的手動修改。
 */
export class Shelf {
  #books = new Map<string, { title: string } & Known>();
  #catalogSeq = 0;
  #applied = new Map<string, Known & { seq: number }>();

  load(catalog: Catalog, entries: readonly Entry[]): void {
    this.#books.clear();
    for (const [code, title, location, loanClass, borrower, at] of catalog.books) {
      this.#books.set(code, { title, state: { location, loanClass, borrower }, at });
    }
    this.#catalogSeq = catalog.seq;
    this.#applied.clear();
    this.apply(entries);
  }

  get size(): number {
    return this.#books.size;
  }

  apply(entries: readonly Entry[]): void {
    for (const e of entries) {
      if (e.seq <= this.#catalogSeq) continue;
      const prev = this.#applied.get(e.code);
      if (!prev || e.seq > prev.seq) this.#applied.set(e.code, { state: e.to, at: e.at, seq: e.seq });
    }
  }

  title(code: string): string {
    return this.#books.get(code)?.title ?? "";
  }

  #known(code: string, pending: readonly Change[]): Known | undefined {
    const book = this.#books.get(code);
    if (!book) return undefined;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].code === code) return { state: pending[i].to, at: pending[i].at };
    return this.#applied.get(code) ?? book;
  }

  state(code: string, pending: readonly Change[]): State | undefined {
    return this.#known(code, pending)?.state;
  }

  /** 把一冊刷成 to：不在書目就是錯誤，已經是 to 就不產生異動，否則產生異動。 */
  scan(code: string, to: State, pending: readonly Change[], next: NewChange): Outcome {
    const state = this.state(code, pending);
    if (state === undefined) return { kind: "unknown", code };
    const title = this.title(code);
    if (sameState(state, to)) return { kind: "here", code, title, state };
    return { kind: "change", title, change: { ...next, code, from: state, to, undo: false } };
  }

  /** 復原一筆異動：把書改回 from。這冊之後又被刷到別處時不復原，避免蓋掉別人的異動。 */
  undo(original: Change, pending: readonly Change[], next: NewChange): Outcome {
    const state = this.state(original.code, pending);
    const title = this.title(original.code);
    if (state === undefined) return { kind: "unknown", code: original.code };
    if (!sameState(state, original.to)) return { kind: "changed-since", code: original.code, title, state };
    return { kind: "change", title, change: { ...next, code: original.code, from: state, to: original.from, undo: true } };
  }

  /** 借閱班級是 loanClass、還沒歸還的書，依借閱時間由舊到新。 */
  openLoans(loanClass: string, pending: readonly Change[]): OpenLoan[] {
    const loans: OpenLoan[] = [];
    for (const [code, book] of this.#books) {
      const known = this.#known(code, pending)!;
      if (known.state.borrower && known.state.loanClass === loanClass) {
        loans.push({ code, title: book.title, borrower: known.state.borrower, at: known.at });
      }
    }
    return loans.sort((a, b) => a.at - b.at);
  }
}

export type Connectivity = "ok" | "delayed" | "offline";

export interface ConnectivityInput {
  now: number;
  /** navigator.onLine */
  online: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  inFlightSince: number | null;
}

/** 超過這個時間仍未回應的請求，才納入判定。 */
export const STALL_MS = 10_000;

/**
 * offline 時禁止刷書；delayed 只提示。
 * 只是慢不算離線：Apps Script 偶有十幾秒的回應，不能因此鎖住入口。
 */
export function connectivity(s: ConnectivityInput): Connectivity {
  if (s.lastSuccessAt === null) return "offline";
  if (s.lastFailureAt !== null && s.lastFailureAt > s.lastSuccessAt) return "offline";
  if (s.inFlightSince !== null && s.now - s.inFlightSince > STALL_MS) {
    return s.online ? "delayed" : "offline";
  }
  return "ok";
}
