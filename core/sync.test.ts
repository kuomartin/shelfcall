import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySync,
  loan,
  loanOps,
  place,
  type BookStore,
  type Change,
  type LoanOp,
  type LoanRecord,
  type LoanStore,
  type LogEntry,
  type LogStore,
  type State,
} from "./sync.ts";

function fakeLog(): LogStore & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    knownScanIds: (ids) => new Set(entries.filter((e) => ids.includes(e.scanId)).map((e) => e.scanId)),
    lastSeq: () => entries.at(-1)?.seq ?? 0,
    append: (batch) => entries.push(...batch),
    since: (cursor) => entries.filter((e) => e.seq > cursor).map(({ seq, scanId, code, at, to }) => ({ seq, scanId, code, at, to })),
  };
}

function fakeLoans(): LoanStore & { ops: LoanOp[] } {
  const records = new Map<string, LoanRecord>();
  const ops: LoanOp[] = [];
  return {
    ops,
    record: (code) => records.get(code),
    commit: (batch, updated) => {
      ops.push(...batch);
      for (const [code, rec] of updated) records.set(code, rec);
    },
  };
}

function fakeBooks(): BookStore & { set: Array<[string, string, number]> } {
  const set: Array<[string, string, number]> = [];
  return { set, setState: (e) => set.push([e.code, e.to.borrower || e.to.location, e.seq]) };
}

function change(scanId: string, code: string, to: State, from: State = place("學校"), undo = false): Change {
  return { scanId, code, from, to, at: Number(scanId.slice(1)), undo };
}

function entries(...changes: Change[]): LogEntry[] {
  return changes.map((c, i) => ({ ...c, seq: i + 1, deviceId: "g" }));
}

const xiaoming = loan("海洋", "小明");
const xiaohua = loan("森林", "小華");

test("appends changes with increasing seq and returns them with the new cursor", () => {
  const log = fakeLog();
  const res = applySync(log, fakeLoans(), fakeBooks(), {
    deviceId: "gate-1",
    cursor: 0,
    changes: [change("s1", "100", place("彩虹")), change("s2", "200", place("彩虹"))],
  });
  assert.deepEqual(log.entries.map((e) => [e.seq, e.scanId, e.deviceId]), [
    [1, "s1", "gate-1"],
    [2, "s2", "gate-1"],
  ]);
  assert.equal(res.cursor, 2);
  assert.deepEqual(res.acked, ["s1", "s2"]);
  assert.deepEqual(res.entries.map((e) => [e.seq, e.to.location]), [
    [1, "彩虹"],
    [2, "彩虹"],
  ]);
});

test("a resent change is acked but not appended or applied twice", () => {
  const log = fakeLog();
  const loans = fakeLoans();
  const books = fakeBooks();
  applySync(log, loans, books, { deviceId: "g", cursor: 0, changes: [change("s1", "100", xiaoming)] });
  const res = applySync(log, loans, books, { deviceId: "g", cursor: 1, changes: [change("s1", "100", xiaoming)] });
  assert.equal(log.entries.length, 1);
  assert.equal(books.set.length, 1);
  assert.equal(loans.ops.length, 1);
  assert.deepEqual(res.acked, ["s1"]);
  assert.deepEqual(res.entries, []);
});

test("the same scanId twice in one batch is appended once", () => {
  const log = fakeLog();
  const c = change("s1", "100", place("彩虹"));
  applySync(log, fakeLoans(), fakeBooks(), { deviceId: "g", cursor: 0, changes: [c, c] });
  assert.equal(log.entries.length, 1);
});

test("only the latest change of a copy in a batch sets its state", () => {
  const books = fakeBooks();
  applySync(fakeLog(), fakeLoans(), books, {
    deviceId: "g",
    cursor: 0,
    changes: [change("s1", "100", place("彩虹")), change("s2", "200", place("海洋")), change("s3", "100", xiaoming, place("彩虹"))],
  });
  assert.deepEqual(books.set, [
    ["100", "小明", 3],
    ["200", "海洋", 2],
  ]);
});

test("returns other gates' changes after the cursor", () => {
  const log = fakeLog();
  applySync(log, fakeLoans(), fakeBooks(), { deviceId: "a", cursor: 0, changes: [change("s1", "100", place("彩虹"))] });
  const res = applySync(log, fakeLoans(), fakeBooks(), { deviceId: "b", cursor: 0, changes: [] });
  assert.deepEqual(res.entries.map((e) => e.scanId), ["s1"]);
  assert.equal(res.cursor, 1);
});

test("borrowing opens a loan and returning closes it", () => {
  const { ops, records } = loanOps(entries(change("s1", "100", xiaoming), change("s2", "100", place("海洋"), xiaoming)), () => undefined);
  assert.deepEqual(ops, [
    { kind: "open", id: "s1", code: "100", loanClass: "海洋", borrower: "小明", at: 1 },
    { kind: "close", id: "s1", code: "100", at: 2, undo: false },
  ]);
  assert.deepEqual(records.get("100"), { id: "s1", loanClass: "海洋", borrower: "小明", open: false });
});

test("lending a copy someone else has closes their loan first", () => {
  const open: LoanRecord = { id: "s1", loanClass: "海洋", borrower: "小明", open: true };
  const { ops } = loanOps(entries(change("s2", "100", xiaohua, xiaoming)), () => open);
  assert.deepEqual(ops, [
    { kind: "close", id: "s1", code: "100", at: 2, undo: false },
    { kind: "open", id: "s2", code: "100", loanClass: "森林", borrower: "小華", at: 2 },
  ]);
});

test("moving a copy closes its loan even when the gate did not know it was lent", () => {
  const open: LoanRecord = { id: "s1", loanClass: "海洋", borrower: "小明", open: true };
  const { ops } = loanOps(entries(change("s2", "100", place("學校"), place("海洋"))), () => open);
  assert.deepEqual(ops, [{ kind: "close", id: "s1", code: "100", at: 2, undo: false }]);
});

test("a loan without bookkeeping is closed by barcode", () => {
  const { ops } = loanOps(entries(change("s2", "100", place("學校"), xiaoming)), () => undefined);
  assert.deepEqual(ops, [{ kind: "close", id: null, code: "100", at: 2, undo: false }]);
});

test("lending to the current borrower again changes nothing", () => {
  const open: LoanRecord = { id: "s1", loanClass: "海洋", borrower: "小明", open: true };
  assert.deepEqual(loanOps(entries(change("s2", "100", xiaoming)), () => open).ops, []);
});

test("undoing a borrow closes the loan as an undo", () => {
  const { ops } = loanOps(entries(change("s1", "100", xiaoming), change("s2", "100", place("學校"), xiaoming, true)), () => undefined);
  assert.deepEqual(ops.at(-1), { kind: "close", id: "s1", code: "100", at: 2, undo: true });
});

test("undoing a return reopens the same loan", () => {
  const closed: LoanRecord = { id: "s1", loanClass: "海洋", borrower: "小明", open: false };
  const { ops, records } = loanOps(entries(change("s3", "100", xiaoming, place("海洋"), true)), () => closed);
  assert.deepEqual(ops, [{ kind: "reopen", id: "s1", code: "100" }]);
  assert.equal(records.get("100")?.open, true);
});

test("borrowing again after a return opens a new loan", () => {
  const closed: LoanRecord = { id: "s1", loanClass: "海洋", borrower: "小明", open: false };
  const { ops } = loanOps(entries(change("s3", "100", xiaoming, place("海洋"))), () => closed);
  assert.deepEqual(ops, [{ kind: "open", id: "s3", code: "100", loanClass: "海洋", borrower: "小明", at: 3 }]);
});
