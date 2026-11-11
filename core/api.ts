// 掃描頁與 Apps Script 之間的請求／回應格式。請求來自匿名呼叫者，進 handler 前一律經過 parseRequest。

import { ON_LOAN, SCHOOL, type Catalog, type Roster } from "./books.ts";
import type { Change, State, SyncRequest, SyncResponse } from "./sync.ts";

export type ApiRequest = { action: "bootstrap" } | ({ action: "sync" } & SyncRequest);

export interface BootstrapResult {
  /** 「學校」與各班級，依設定的順序。 */
  classes: string[];
  roster: Roster;
  catalog: Catalog;
}

export interface SyncResult extends SyncResponse {
  catalogVersion: string;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** 一次同步最多帶的異動筆數；正常情況一批只有幾筆。 */
export const MAX_BATCH = 500;
const MAX_TEXT = 200;

function fail(message: string): never {
  throw new Error(`無效的請求：${message}`);
}

function str(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > MAX_TEXT) fail(name);
  return value;
}

function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(name);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail(name);
  return value as Record<string, unknown>;
}

/** from 是掃描頁看到的狀態，試算表上可能是空白或不一致，只檢查型別。 */
function loose(value: unknown, name: string): State {
  const v = object(value, name);
  return {
    location: str(v.location, `${name}.location`, true),
    loanClass: str(v.loanClass, `${name}.loanClass`, true),
    borrower: str(v.borrower, `${name}.borrower`, true),
  };
}

/** to 是要寫進 Books 的狀態：借出中就一定有借閱班級與借閱人，否則一定沒有。 */
function strict(value: unknown, name: string): State {
  const s = loose(value, name);
  if (!s.location) fail(`${name}.location`);
  const lent = s.location === ON_LOAN;
  if (lent !== Boolean(s.borrower) || lent !== Boolean(s.loanClass) || s.loanClass === SCHOOL) fail(`${name}.borrower`);
  return s;
}

function change(value: unknown): Change {
  const v = object(value, "change");
  return {
    scanId: str(v.scanId, "scanId"),
    code: str(v.code, "code"),
    from: loose(v.from, "from"),
    to: strict(v.to, "to"),
    at: nonNegative(v.at, "at"),
    undo: v.undo === true,
  };
}

export function parseRequest(body: unknown): ApiRequest {
  const b = object(body, "body");
  switch (b.action) {
    case "bootstrap":
      return { action: "bootstrap" };
    case "sync": {
      if (!Array.isArray(b.changes) || b.changes.length > MAX_BATCH) fail("changes");
      return {
        action: "sync",
        deviceId: str(b.deviceId, "deviceId"),
        cursor: nonNegative(b.cursor, "cursor"),
        changes: b.changes.map(change),
      };
    }
    default:
      fail("action");
  }
}

/** 異動的目的地要在班級清單與幼兒名單裡；回傳不符的描述，空陣列表示都可以。 */
export function unknownTargets(changes: readonly Change[], classes: readonly string[], roster: Roster): string[] {
  const unknown = new Set<string>();
  for (const { to } of changes) {
    if (to.location !== ON_LOAN && !classes.includes(to.location)) unknown.add(to.location);
    if (to.borrower && !roster[to.loanClass]?.includes(to.borrower)) unknown.add(`${to.loanClass} ${to.borrower}`);
  }
  return [...unknown];
}
