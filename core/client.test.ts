import { test } from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "./books.ts";
import { connectivity, Shelf, SyncClient } from "./client.ts";
import type { LogEntry, Transfer } from "./sync.ts";

const catalog: Catalog = {
  version: "v",
  seq: 10,
  books: [
    ["100", "蝴蝶", "學校"],
    ["200", "恐龍", "彩虹"],
  ],
};

function entry(seq: number, code: string, to: string, from = "學校"): LogEntry {
  return { seq, scanId: `s${seq}`, code, from, to, at: seq, deviceId: "other" };
}

const next = { scanId: "new", at: 99 };

function shelf(entries: LogEntry[] = []): Shelf {
  const s = new Shelf();
  s.load(catalog, entries);
  return s;
}

test("scanning a copy held elsewhere moves it", () => {
  assert.deepEqual(shelf().scan("100", "彩虹", [], next), {
    kind: "move",
    title: "蝴蝶",
    transfer: { scanId: "new", at: 99, code: "100", from: "學校", to: "彩虹" },
  });
});

test("scanning a copy already with the holder makes no transfer", () => {
  assert.deepEqual(shelf().scan("200", "彩虹", [], next), { kind: "here", code: "200", title: "恐龍", holder: "彩虹" });
});

test("scanning an unknown barcode is an error", () => {
  assert.deepEqual(shelf().scan("999", "彩虹", [], next), { kind: "unknown", code: "999" });
});

test("pending transfers win over the catalog", () => {
  const pending: Transfer[] = [{ scanId: "p", code: "100", from: "學校", to: "海洋", at: 1 }];
  assert.equal(shelf().holder("100", pending), "海洋");
  assert.equal(shelf().scan("100", "海洋", pending, next).kind, "here");
});

test("synced transfers after the catalog seq apply in seq order", () => {
  const s = shelf([entry(12, "100", "海洋"), entry(11, "100", "彩虹")]);
  assert.equal(s.holder("100", []), "海洋");
});

test("transfers already in the catalog do not override it", () => {
  // seq 9 已經寫進 Books；之後有人在試算表上手改，快取讀到的是手改後的值。
  const s = shelf([entry(9, "200", "海洋")]);
  assert.equal(s.holder("200", []), "彩虹");
});

test("undo moves the copy back to where it came from", () => {
  const original: Transfer = { scanId: "m", code: "100", from: "學校", to: "彩虹", at: 1 };
  const s = shelf([{ ...original, seq: 11, deviceId: "me" }]);
  assert.deepEqual(s.undo(original, [], next), {
    kind: "move",
    title: "蝴蝶",
    transfer: { scanId: "new", at: 99, code: "100", from: "彩虹", to: "學校" },
  });
});

test("undo refuses when the copy has moved since", () => {
  const original: Transfer = { scanId: "m", code: "100", from: "學校", to: "彩虹", at: 1 };
  const s = shelf([{ ...original, seq: 11, deviceId: "me" }, entry(12, "100", "海洋", "彩虹")]);
  assert.deepEqual(s.undo(original, [], next), { kind: "moved-since", code: "100", title: "蝴蝶", holder: "海洋" });
});

test("sync client drops acked transfers and keeps entries by scanId", () => {
  const c = new SyncClient("me");
  c.enqueue({ scanId: "a", code: "100", from: "學校", to: "彩虹", at: 1 });
  c.enqueue({ scanId: "b", code: "200", from: "彩虹", to: "學校", at: 2 });
  assert.deepEqual(c.request().transfers.map((t) => t.scanId), ["a", "b"]);
  c.receive({ cursor: 5, acked: ["a"], entries: [entry(5, "100", "彩虹"), entry(4, "200", "海洋")] });
  assert.deepEqual(c.pending().map((t) => t.scanId), ["b"]);
  assert.deepEqual(c.entries().map((e) => e.seq), [4, 5]);
  assert.equal(c.request().cursor, 5);
});

test("only a failed or stalled offline request counts as offline", () => {
  const base = { now: 20_000, online: true, lastSuccessAt: 1, lastFailureAt: null, inFlightSince: null };
  assert.equal(connectivity({ ...base, lastSuccessAt: null }), "offline");
  assert.equal(connectivity(base), "ok");
  assert.equal(connectivity({ ...base, lastFailureAt: 2 }), "offline");
  assert.equal(connectivity({ ...base, inFlightSince: 5_000 }), "delayed");
  assert.equal(connectivity({ ...base, inFlightSince: 5_000, online: false }), "offline");
});
