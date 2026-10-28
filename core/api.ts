// 掃描頁與 Apps Script 之間的請求／回應格式。請求來自匿名呼叫者，進 handler 前一律經過 parseRequest。

import type { Catalog } from "./books.ts";
import type { SyncRequest, SyncResponse, Transfer } from "./sync.ts";

export type ApiRequest = { action: "bootstrap" } | ({ action: "sync" } & SyncRequest);

export interface BootstrapResult {
  holders: string[];
  catalog: Catalog;
}

export interface SyncResult extends SyncResponse {
  catalogVersion: string;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** 一次同步最多帶的移交筆數；正常情況一批只有幾筆。 */
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

function transfer(value: unknown): Transfer {
  if (typeof value !== "object" || value === null) fail("transfer");
  const v = value as Record<string, unknown>;
  return {
    scanId: str(v.scanId, "scanId"),
    code: str(v.code, "code"),
    // 試算表上的保管人可能是空白。
    from: str(v.from, "from", true),
    to: str(v.to, "to"),
    at: nonNegative(v.at, "at"),
  };
}

export function parseRequest(body: unknown): ApiRequest {
  if (typeof body !== "object" || body === null) fail("body");
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case "bootstrap":
      return { action: "bootstrap" };
    case "sync": {
      if (!Array.isArray(b.transfers) || b.transfers.length > MAX_BATCH) fail("transfers");
      return {
        action: "sync",
        deviceId: str(b.deviceId, "deviceId"),
        cursor: nonNegative(b.cursor, "cursor"),
        transfers: b.transfers.map(transfer),
      };
    }
    default:
      fail("action");
  }
}
