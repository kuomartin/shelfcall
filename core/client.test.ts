import { test } from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "./books.ts";
import { connectivity, Shelf, SyncClient } from "./client.ts";
import { loan, place, type Change, type Entry, type State } from "./sync.ts";

const catalog: Catalog = {
  version: "v",
  seq: 10,
  books: [
    ["100", "蝴蝶", "學校", "", "", 0],
    ["200", "恐龍", "彩虹", "", "", 0],
    ["300", "喵喵，汪！", "借出中", "海洋", "小明", 5],
  ],
};

function entry(seq: number, code: string, to: State): Entry {
  return { seq, scanId: `s${seq}`, code, at: seq, to };
}

const next = { scanId: "new", at: 99 };

function shelf(entries: Entry[] = []): Shelf {
  const s = new Shelf();
  s.load(catalog, entries);
  return s;
}

test("scanning a copy elsewhere moves it", () => {
  assert.deepEqual(shelf().scan("100", place("彩虹"), [], next), {
    kind: "change",
    title: "蝴蝶",
    change: { scanId: "new", at: 99, code: "100", from: place("學校"), to: place("彩虹"), undo: false },
  });
});

test("scanning a copy already in the target state makes no change", () => {
  assert.deepEqual(shelf().scan("200", place("彩虹"), [], next), { kind: "here", code: "200", title: "恐龍", state: place("彩虹") });
  assert.equal(shelf().scan("300", loan("海洋", "小明"), [], next).kind, "here");
});

test("scanning a lent copy to a place returns it there", () => {
  const outcome = shelf().scan("300", place("海洋"), [], next);
  assert.equal(outcome.kind, "change");
  assert.deepEqual(outcome.kind === "change" && outcome.change.from, loan("海洋", "小明"));
});

test("lending a copy someone else has hands it over", () => {
  const outcome = shelf().scan("300", loan("森林", "小華"), [], next);
  assert.deepEqual(outcome.kind === "change" && [outcome.change.from, outcome.change.to], [loan("海洋", "小明"), loan("森林", "小華")]);
});

test("scanning an unknown barcode is an error", () => {
  assert.deepEqual(shelf().scan("999", place("彩虹"), [], next), { kind: "unknown", code: "999" });
});

test("pending changes win over the catalog", () => {
  const pending: Change[] = [{ scanId: "p", code: "100", from: place("學校"), to: place("海洋"), at: 1, undo: false }];
  assert.deepEqual(shelf().state("100", pending), place("海洋"));
  assert.equal(shelf().scan("100", place("海洋"), pending, next).kind, "here");
});

test("synced changes after the catalog seq apply in seq order", () => {
  const s = shelf([entry(12, "100", place("海洋")), entry(11, "100", place("彩虹"))]);
  assert.deepEqual(s.state("100", []), place("海洋"));
});

test("changes already in the catalog do not override it", () => {
  // seq 9 已經寫進 Books；之後有人在試算表上手改，快取讀到的是手改後的值。
  const s = shelf([entry(9, "200", place("海洋"))]);
  assert.deepEqual(s.state("200", []), place("彩虹"));
});

test("undo changes the copy back to what it was", () => {
  const original: Change = { scanId: "m", code: "100", from: place("學校"), to: loan("海洋", "小明"), at: 1, undo: false };
  const s = shelf([{ ...entry(11, "100", original.to), scanId: "m" }]);
  assert.deepEqual(s.undo(original, [], next), {
    kind: "change",
    title: "蝴蝶",
    change: { scanId: "new", at: 99, code: "100", from: loan("海洋", "小明"), to: place("學校"), undo: true },
  });
});

test("undo refuses when the copy has changed since", () => {
  const original: Change = { scanId: "m", code: "100", from: place("學校"), to: place("彩虹"), at: 1, undo: false };
  const s = shelf([entry(11, "100", place("彩虹")), entry(12, "100", place("海洋"))]);
  assert.deepEqual(s.undo(original, [], next), { kind: "changed-since", code: "100", title: "蝴蝶", state: place("海洋") });
});

test("open loans of a class include synced and pending loans, oldest first", () => {
  const s = shelf([entry(11, "100", loan("海洋", "小美")), entry(12, "200", loan("森林", "小華"))]);
  const pending: Change[] = [{ scanId: "p", code: "300", from: loan("海洋", "小明"), to: place("海洋"), at: 20, undo: false }];
  assert.deepEqual(s.openLoans("海洋", []).map((l) => [l.code, l.borrower, l.at]), [
    ["300", "小明", 5],
    ["100", "小美", 11],
  ]);
  assert.deepEqual(s.openLoans("海洋", pending).map((l) => l.code), ["100"]);
});

test("sync client drops acked changes and keeps entries by scanId", () => {
  const c = new SyncClient("me");
  c.enqueue({ scanId: "a", code: "100", from: place("學校"), to: place("彩虹"), at: 1, undo: false });
  c.enqueue({ scanId: "b", code: "200", from: place("彩虹"), to: place("學校"), at: 2, undo: false });
  assert.deepEqual(c.request().changes.map((t) => t.scanId), ["a", "b"]);
  c.receive({ cursor: 5, acked: ["a"], entries: [{ ...entry(5, "100", place("彩虹")), scanId: "a" }, entry(4, "200", place("海洋"))] });
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
