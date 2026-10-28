import { test } from "node:test";
import assert from "node:assert/strict";
import { applySync, type HolderStore, type LogEntry, type LogStore, type Transfer } from "./sync.ts";

function fakeLog(): LogStore & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    knownScanIds: (ids) => new Set(entries.filter((e) => ids.includes(e.scanId)).map((e) => e.scanId)),
    lastSeq: () => entries.at(-1)?.seq ?? 0,
    append: (batch) => entries.push(...batch),
    since: (cursor) => entries.filter((e) => e.seq > cursor),
  };
}

function fakeHolders(): HolderStore & { set: Array<[string, string, number]> } {
  const set: Array<[string, string, number]> = [];
  return { set, setHolder: (e) => set.push([e.code, e.to, e.seq]) };
}

function transfer(scanId: string, code: string, to: string, from = "學校"): Transfer {
  return { scanId, code, from, to, at: 1000 };
}

test("appends transfers with increasing seq and returns them with the new cursor", () => {
  const log = fakeLog();
  const res = applySync(log, fakeHolders(), {
    deviceId: "gate-1",
    cursor: 0,
    transfers: [transfer("s1", "100", "彩虹"), transfer("s2", "200", "彩虹")],
  });
  assert.deepEqual(log.entries.map((e) => [e.seq, e.scanId, e.deviceId]), [
    [1, "s1", "gate-1"],
    [2, "s2", "gate-1"],
  ]);
  assert.equal(res.cursor, 2);
  assert.deepEqual(res.acked, ["s1", "s2"]);
  assert.deepEqual(res.entries.map((e) => e.seq), [1, 2]);
});

test("a resent transfer is acked but not appended or applied twice", () => {
  const log = fakeLog();
  const holders = fakeHolders();
  applySync(log, holders, { deviceId: "g", cursor: 0, transfers: [transfer("s1", "100", "彩虹")] });
  const res = applySync(log, holders, { deviceId: "g", cursor: 1, transfers: [transfer("s1", "100", "彩虹")] });
  assert.equal(log.entries.length, 1);
  assert.equal(holders.set.length, 1);
  assert.deepEqual(res.acked, ["s1"]);
  assert.deepEqual(res.entries, []);
});

test("the same scanId twice in one batch is appended once", () => {
  const log = fakeLog();
  applySync(log, fakeHolders(), { deviceId: "g", cursor: 0, transfers: [transfer("s1", "100", "彩虹"), transfer("s1", "100", "彩虹")] });
  assert.equal(log.entries.length, 1);
});

test("only the latest transfer of a copy in a batch sets its holder", () => {
  const holders = fakeHolders();
  applySync(fakeLog(), holders, {
    deviceId: "g",
    cursor: 0,
    transfers: [transfer("s1", "100", "彩虹"), transfer("s2", "200", "海洋"), transfer("s3", "100", "學校", "彩虹")],
  });
  assert.deepEqual(holders.set, [
    ["100", "學校", 3],
    ["200", "海洋", 2],
  ]);
});

test("returns other gates' transfers after the cursor", () => {
  const log = fakeLog();
  applySync(log, fakeHolders(), { deviceId: "a", cursor: 0, transfers: [transfer("s1", "100", "彩虹")] });
  const res = applySync(log, fakeHolders(), { deviceId: "b", cursor: 0, transfers: [] });
  assert.deepEqual(res.entries.map((e) => [e.scanId, e.deviceId]), [["s1", "a"]]);
  assert.equal(res.cursor, 1);
});
