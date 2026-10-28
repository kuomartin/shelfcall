import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH, parseRequest } from "./api.ts";

const t = { scanId: "s1", code: "100", from: "", to: "彩虹", at: 1 };

test("parses bootstrap and sync", () => {
  assert.deepEqual(parseRequest({ action: "bootstrap", extra: 1 }), { action: "bootstrap" });
  assert.deepEqual(parseRequest({ action: "sync", deviceId: "d", cursor: 0, transfers: [{ ...t, junk: true }] }), {
    action: "sync",
    deviceId: "d",
    cursor: 0,
    transfers: [t],
  });
});

test("rejects malformed requests", () => {
  const sync = { action: "sync", deviceId: "d", cursor: 0, transfers: [t] };
  assert.throws(() => parseRequest(null), /body/);
  assert.throws(() => parseRequest({ action: "lookup" }), /action/);
  assert.throws(() => parseRequest({ ...sync, cursor: -1 }), /cursor/);
  assert.throws(() => parseRequest({ ...sync, transfers: [{ ...t, to: "" }] }), /to/);
  assert.throws(() => parseRequest({ ...sync, transfers: [{ ...t, code: "x".repeat(201) }] }), /code/);
  assert.throws(() => parseRequest({ ...sync, transfers: Array(MAX_BATCH + 1).fill(t) }), /transfers/);
});
