// 掃描端的狀態：每冊目前的保管人、刷書判定、待送佇列、cursor、連線判定。
// 不碰網路、計時器與 DOM；由 web 層決定何時 request()、把回應交給 receive()。

import type { Catalog } from "./books.ts";
import type { LogEntry, SyncRequest, SyncResponse, Transfer } from "./sync.ts";

export class SyncClient {
  readonly deviceId: string;
  #queue: Transfer[] = [];
  #cursor = 0;
  #entries = new Map<string, LogEntry>();

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  enqueue(transfer: Transfer): void {
    this.#queue.push(transfer);
  }

  pending(): readonly Transfer[] {
    return this.#queue;
  }

  /** 伺服器回傳的移交，依 seq 排序。 */
  entries(): LogEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
  }

  /** 送出整個佇列；回應前新進的移交留到下一次。 */
  request(): SyncRequest {
    return { deviceId: this.deviceId, cursor: this.#cursor, transfers: [...this.#queue] };
  }

  receive(res: SyncResponse): void {
    const acked = new Set(res.acked);
    this.#queue = this.#queue.filter((t) => !acked.has(t.scanId));
    for (const entry of res.entries) this.#entries.set(entry.scanId, entry);
    this.#cursor = Math.max(this.#cursor, res.cursor);
  }
}

export type Outcome =
  | { kind: "unknown"; code: string }
  | { kind: "here"; code: string; title: string; holder: string }
  | { kind: "move"; title: string; transfer: Transfer }
  /** 復原時，這冊已經被移到別處，不是當初移去的保管人。 */
  | { kind: "moved-since"; code: string; title: string; holder: string };

export interface NewTransfer {
  scanId: string;
  at: number;
}

/**
 * 每冊目前的保管人：書目快取的保管人，套上 seq 大於快取 seq 的移交，再套上還沒送出的移交。
 * 快取 seq 以前的移交已經寫進 Books，再套一次會蓋掉之後在試算表上的手動修改。
 */
export class Shelf {
  #books = new Map<string, { title: string; holder: string }>();
  #catalogSeq = 0;
  #applied = new Map<string, { to: string; seq: number }>();

  load(catalog: Catalog, entries: readonly LogEntry[]): void {
    this.#books.clear();
    for (const [code, title, holder] of catalog.books) this.#books.set(code, { title, holder });
    this.#catalogSeq = catalog.seq;
    this.#applied.clear();
    this.apply(entries);
  }

  get size(): number {
    return this.#books.size;
  }

  apply(entries: readonly LogEntry[]): void {
    for (const e of entries) {
      if (e.seq <= this.#catalogSeq) continue;
      const prev = this.#applied.get(e.code);
      if (!prev || e.seq > prev.seq) this.#applied.set(e.code, { to: e.to, seq: e.seq });
    }
  }

  title(code: string): string {
    return this.#books.get(code)?.title ?? "";
  }

  holder(code: string, pending: readonly Transfer[]): string | undefined {
    const book = this.#books.get(code);
    if (!book) return undefined;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].code === code) return pending[i].to;
    return this.#applied.get(code)?.to ?? book.holder;
  }

  /** 把一冊刷到 to：不在書目就是錯誤，已在 to 就不產生移交，否則移交。 */
  scan(code: string, to: string, pending: readonly Transfer[], next: NewTransfer): Outcome {
    const holder = this.holder(code, pending);
    if (holder === undefined) return { kind: "unknown", code };
    const title = this.title(code);
    if (holder === to) return { kind: "here", code, title, holder };
    return { kind: "move", title, transfer: { ...next, code, from: holder, to } };
  }

  /** 復原一筆移交：把書移回 from。這冊之後已被移到別處時不復原，避免蓋掉別人的移交。 */
  undo(original: Transfer, pending: readonly Transfer[], next: NewTransfer): Outcome {
    const holder = this.holder(original.code, pending);
    const title = this.title(original.code);
    if (holder === undefined) return { kind: "unknown", code: original.code };
    if (holder !== original.to) return { kind: "moved-since", code: original.code, title, holder };
    return { kind: "move", title, transfer: { ...next, code: original.code, from: holder, to: original.from } };
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
