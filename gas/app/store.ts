// 同步的儲存實作。
//
// lock 只保護記帳：seq、移交紀錄下一個可寫的列、近期紀錄、已見過的 scanId、每冊最新的 seq（都在 Properties／CacheService）。
// 寫進 Sheet 的動作在放開 lock 之後進行：每次同步在 lock 內預留不重疊的列範圍，各自寫入不會互相覆蓋。
// lock 內若讀寫 Sheet，一次要持有約 1 秒以上，幾台入口同時同步就會排隊等到逾時。
//
// 已見過的 scanId 存在 CacheService：快取被清掉後重送的移交可能多寫一列。重複的移交結果相同，所以接受。

import { bookIndex, HOLDER_FIELD, TITLE_FIELD, UPDATED_FIELD, text, type BookTable } from "../../core/books.ts";
import type { HolderStore, LogEntry, LogStore } from "../../core/sync.ts";
import { booksSheet, columnName, DATETIME_FORMAT, ensureLogSheet, LOG_HEADERS, LOG_SHEET } from "./sheets.ts";

const WIDTH = LOG_HEADERS.length;
const CACHE_TTL_S = 21_600;
const RECENT_LIMIT = 300;
const RECENT_KEY = "recent";
const SEQ_KEY = "seq";
const ROW_KEY = "row";
const scanKey = (scanId: string) => `scan:${scanId}`;
const holderKey = (code: string) => `holder:${code}`;

/** 近期紀錄多存一個 loggedAt（伺服器在 lock 內記帳的時間），給 catalogSeq 判斷哪些移交可能還沒寫進 Books。 */
type RecentEntry = LogEntry & { loggedAt?: number };

function toEntry({ loggedAt: _, ...entry }: RecentEntry): LogEntry {
  return entry;
}

function readLogTail(): RecentEntry[] {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const first = Math.max(2, sheet.getLastRow() - RECENT_LIMIT + 1);
  const entries: RecentEntry[] = [];
  for (const r of sheet.getRange(first, 1, sheet.getLastRow() - first + 1, WIDTH).getValues()) {
    const seq = Number(r[0]);
    if (!Number.isFinite(seq) || seq <= 0) continue;
    const at = r[2] instanceof Date ? r[2].getTime() : Number(r[2]);
    entries.push({ seq, scanId: String(r[1]), at, code: text(r[3]), from: text(r[5]), to: text(r[6]), deviceId: text(r[7]) });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export interface Reservation {
  row: number;
  entries: LogEntry[];
}

/** 必須在 script lock 內建立與使用；寫 Sheet 交給 writeReservation 與 writeHolders。 */
export class LockedLogStore implements LogStore {
  reservation: Reservation | null = null;
  #props = PropertiesService.getScriptProperties();
  #cache = CacheService.getScriptCache();
  #recent: RecentEntry[];
  #seq: number;
  #stored: Record<string, string>;
  #cached: Record<string, string>;

  /** lock 內每次 Properties／Cache 呼叫約 50 ms，所以一次讀齊。 */
  constructor(scanIds: string[]) {
    this.#stored = this.#props.getProperties();
    this.#cached = this.#cache.getAll([RECENT_KEY, ...scanIds.map(scanKey)]);
    const recent = this.#cached[RECENT_KEY];
    // 快取被清掉時，從移交紀錄的最後幾列重建。
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
    const row = Number(this.#stored[ROW_KEY] ?? 0) || ensureLogSheet().getLastRow() + 1;
    this.reservation = { row, entries };
    this.#seq = entries.reduce((max, e) => Math.max(max, e.seq), this.#seq);
    this.#props.setProperties({ [SEQ_KEY]: String(this.#seq), [ROW_KEY]: String(row + entries.length) });

    const loggedAt = Date.now();
    this.#recent = [...this.#recent, ...entries.map((e) => ({ ...e, loggedAt }))].slice(-RECENT_LIMIT);
    // entries 依 seq 排序，同一冊的後一筆覆蓋前一筆。
    const holders = Object.fromEntries(entries.map((e) => [holderKey(e.code), String(e.seq)]));
    const scans = Object.fromEntries(entries.map((e) => [scanKey(e.scanId), "1"]));
    this.#cache.putAll({ [RECENT_KEY]: JSON.stringify(this.#recent), ...scans, ...holders }, CACHE_TTL_S);
  }

  /** 只涵蓋最近 300 筆；更早的 cursor（例如剛開頁的裝置）拿到的就是這 300 筆。 */
  since(cursor: number): LogEntry[] {
    return this.#recent.filter((e) => e.seq > cursor).map(toEntry);
  }
}

/** 收集每冊的新保管人，放開 lock 後由 writeHolders 寫入。 */
export class DeferredHolderStore implements HolderStore {
  readonly entries: LogEntry[] = [];

  setHolder(entry: LogEntry): void {
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
 * 就改在 lock 內接在最後一列之後寫，並校正計數器。
 */
export function writeReservation(reservation: Reservation | null, books: BookTable): void {
  if (!reservation) return;
  const sheet = ensureLogSheet();
  const index = bookIndex(books);
  const titleCol = books.headers.indexOf(TITLE_FIELD);
  const rows = reservation.entries.map((e) => {
    const book = books.rows[index.get(e.code) ?? -1];
    return [e.seq, e.scanId, new Date(e.at), e.code, book ? book[titleCol] : "", e.from, e.to, e.deviceId];
  });
  const target = sheet.getRange(reservation.row, 1, rows.length, WIDTH);
  if (target.getValues().every((r) => r.every((v) => v === ""))) {
    target.setValues(rows);
    return;
  }
  withLock(() => {
    const at = sheet.getLastRow() + 1;
    sheet.getRange(at, 1, rows.length, WIDTH).setValues(rows);
    SpreadsheetApp.flush();
    const props = PropertiesService.getScriptProperties();
    props.setProperty(ROW_KEY, String(Math.max(at + rows.length, Number(props.getProperty(ROW_KEY) ?? 0))));
  });
}

/**
 * 寫 Books 的保管人與更新時間。寫入前比對快取裡每冊最新的 seq：另一次同步已經記下更新的移交，這筆就不寫，
 * 免得兩批放開 lock 後的寫入順序顛倒，讓舊的保管人蓋掉新的。比對與寫入之間仍有極小的空窗，接受。
 * 依保管人分組，用 RangeList 一次寫一組，不逐格呼叫。
 */
export function writeHolders(entries: LogEntry[], books: BookTable): void {
  if (!entries.length) return;
  const latest = CacheService.getScriptCache().getAll(entries.map((e) => holderKey(e.code)));
  const current = entries.filter((e) => Number(latest[holderKey(e.code)] ?? 0) <= e.seq);
  const index = bookIndex(books);
  const holderCol = columnName(books.headers.indexOf(HOLDER_FIELD) + 1);
  const updatedIdx = books.headers.indexOf(UPDATED_FIELD);
  const updatedCol = updatedIdx === -1 ? null : columnName(updatedIdx + 1);

  const byHolder = new Map<string, number[]>();
  for (const e of current) {
    const i = index.get(e.code);
    if (i === undefined) continue;
    byHolder.set(e.to, [...(byHolder.get(e.to) ?? []), i + 2]);
  }
  if (!byHolder.size) return;
  const sheet = booksSheet();
  for (const [holder, rows] of byHolder) sheet.getRangeList(rows.map((r) => `${holderCol}${r}`)).setValue(holder);
  if (updatedCol) {
    const rows = [...byHolder.values()].flat();
    sheet.getRangeList(rows.map((r) => `${updatedCol}${r}`)).setValue(new Date()).setNumberFormat(DATETIME_FORMAT);
  }
}

/**
 * 書目快取的 seq：這個 seq 以前的移交，掃描頁視為已經寫進 Books。
 * 一分鐘內記帳的移交可能還沒寫完（寫入在放開 lock 之後），所以退到它們之前，讓掃描頁再套一次。
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
 * 只給端到端測試用：清空移交紀錄。Books 不動。
 * seq 不歸零：快取裡每冊最新的 seq 還在，歸零後新的移交會被 writeHolders 當成舊的而不寫。
 */
export function resetLog(): void {
  withLock(() => {
    const sheet = ensureLogSheet();
    if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).clearContent();
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty(ROW_KEY, "2");
    CacheService.getScriptCache().put(RECENT_KEY, "[]", CACHE_TTL_S);
  });
}
