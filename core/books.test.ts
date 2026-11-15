import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookIndex,
  buildCatalog,
  buildRoster,
  checkBooks,
  checkRoster,
  missingRequired,
  parseClasses,
  statusOf,
  type Table,
} from "./books.ts";

const headers = ["系統ID", "書名", "主條碼", "ISBN", "位置", "借閱班級", "借閱人", "借閱日期", "狀態"];
const classes = ["學校", "彩虹", "海洋"];
const day = new Date(2026, 10, 1);

function table(...rows: unknown[][]): Table {
  return { headers, rows };
}

function book(id: number, title: string, code: unknown, location: string, loanClass = "", borrower = "", at: unknown = ""): unknown[] {
  return [id, title, code, "", location, loanClass, borrower, at, ""];
}

test("reports missing required columns", () => {
  assert.deepEqual(missingRequired(["主條碼", "書名", "位置", "借閱班級", "借閱人", "狀態"]), ["借閱日期"]);
  assert.throws(() => buildCatalog({ headers: ["書名"], rows: [] }, "v", 0), /主條碼、位置/);
});

test("catalog finds columns by header and keeps barcodes as text", () => {
  const t = table(book(1, "蝴蝶", "000070", "學校"), book(2, " 恐龍 ", " 200116 ", "借出中", "海洋", "小明", day));
  assert.deepEqual(buildCatalog(t, "v1", 7), {
    version: "v1",
    seq: 7,
    books: [
      ["000070", "蝴蝶", "學校", "", "", 0],
      ["200116", "恐龍", "借出中", "海洋", "小明", day.getTime()],
    ],
  });
});

test("catalog skips rows without a barcode and keeps the first of duplicates", () => {
  const t = table(book(1, "", "", "學校"), book(2, "A", "100", "學校"), book(3, "B", "100", "彩虹"));
  assert.deepEqual(buildCatalog(t, "v", 0).books, [["100", "A", "學校", "", "", 0]]);
  assert.deepEqual([...bookIndex(t)], [["100", 1]]);
});

test("status follows the location", () => {
  assert.deepEqual(["學校", "海洋", "借出中", ""].map(statusOf), ["在館", "班級使用中", "幼兒借閱中", ""]);
});

test("checkBooks lists rows a person has to fix", () => {
  const t = table(
    book(1, "A", "100", "學校"),
    book(2, "B", "100", "學校"),
    book(3, "C", 70, "學校"),
    book(4, "D", "200", "雲朵"),
    book(5, "E", "300", ""),
    book(6, "F", "", "學校"),
    book(7, "", "", ""),
    book(8, "G", "400", "借出中"),
    book(9, "H", "500", "海洋", "海洋", "小明"),
    book(10, "I", "600", "借出中", "", "小華"),
  );
  assert.deepEqual(
    checkBooks(t, classes).map((i) => [i.row, i.problem]),
    [
      [3, "條碼與第 2 列重複"],
      [4, "條碼是數字格式，開頭的 0 可能已遺失"],
      [5, "位置「雲朵」不在班級清單裡"],
      [6, "沒有位置"],
      [7, "沒有條碼"],
      [9, "位置是借出中，但沒有借閱人"],
      [10, "有借閱人，但位置不是借出中"],
      [11, "有借閱人，但沒有借閱班級"],
    ],
  );
});

const rosterHeaders = ["班級", "座號", "姓名"];

test("roster groups children by class in seat order", () => {
  const t: Table = {
    headers: rosterHeaders,
    rows: [
      ["海洋", 2, "小美"],
      ["海洋", "", "小強"],
      ["海洋", 1, " 小明 "],
      ["彩虹", 1, "小華"],
      ["海洋", 3, "小明"],
      ["雲朵", 1, "小玉"],
      ["學校", 1, "老師"],
    ],
  };
  assert.deepEqual(buildRoster(t, classes), { 海洋: ["小明", "小美", "小強"], 彩虹: ["小華"] });
});

test("checkRoster lists rows a person has to fix", () => {
  const t: Table = {
    headers: rosterHeaders,
    rows: [
      ["海洋", 1, "小明"],
      ["海洋", 2, "小明"],
      ["雲朵", 1, "小玉"],
      ["", 1, "小華"],
      ["彩虹", 1, ""],
      ["", "", ""],
    ],
  };
  assert.deepEqual(
    checkRoster(t, classes).map((i) => [i.row, i.problem]),
    [
      [3, "與第 2 列同班同名"],
      [4, "班級「雲朵」不在班級清單裡"],
      [5, "沒有班級"],
      [6, "沒有姓名"],
    ],
  );
});

test("class list always starts with the school and never contains the loan location", () => {
  assert.deepEqual(parseClasses(" 彩虹，海洋, 彩虹 、雲朵\n"), ["學校", "彩虹", "海洋", "雲朵"]);
  assert.deepEqual(parseClasses("彩虹, 學校, 借出中"), ["學校", "彩虹"]);
  assert.deepEqual(parseClasses(""), ["學校"]);
});
