import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH, parseRequest, unknownTargets } from "./api.ts";
import { loan, place } from "./sync.ts";

const c = { scanId: "s1", code: "100", from: place(""), to: loan("海洋", "小明"), at: 1, undo: false };

test("parses bootstrap and sync", () => {
  assert.deepEqual(parseRequest({ action: "bootstrap", extra: 1 }), { action: "bootstrap" });
  assert.deepEqual(parseRequest({ action: "sync", deviceId: "d", cursor: 0, changes: [{ ...c, undo: "yes", junk: true }] }), {
    action: "sync",
    deviceId: "d",
    cursor: 0,
    changes: [c],
  });
});

test("rejects malformed requests", () => {
  const sync = { action: "sync", deviceId: "d", cursor: 0, changes: [c] };
  const bad = (change: object) => ({ ...sync, changes: [{ ...c, ...change }] });
  assert.throws(() => parseRequest(null), /body/);
  assert.throws(() => parseRequest({ action: "lookup" }), /action/);
  assert.throws(() => parseRequest({ ...sync, cursor: -1 }), /cursor/);
  assert.throws(() => parseRequest(bad({ to: place("") })), /to.location/);
  assert.throws(() => parseRequest(bad({ to: loan("海洋", "") })), /to.borrower/);
  assert.throws(() => parseRequest(bad({ to: { ...place("海洋"), borrower: "小明" } })), /to.borrower/);
  assert.throws(() => parseRequest(bad({ to: loan("學校", "小明") })), /to.borrower/);
  assert.throws(() => parseRequest(bad({ from: null })), /from/);
  assert.throws(() => parseRequest(bad({ code: "x".repeat(201) })), /code/);
  assert.throws(() => parseRequest({ ...sync, changes: Array(MAX_BATCH + 1).fill(c) }), /changes/);
});

test("targets must be in the class list and roster", () => {
  const roster = { 海洋: ["小明"] };
  const changes = [c, { ...c, to: place("彩虹") }, { ...c, to: loan("海洋", "小美") }, { ...c, to: place("雲朵") }];
  assert.deepEqual(unknownTargets(changes, ["學校", "彩虹", "海洋"], roster), ["海洋 小美", "雲朵"]);
});
