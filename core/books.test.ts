import { test } from "node:test";
import assert from "node:assert/strict";
import { bookIndex, buildCatalog, checkBooks, missingRequired, parseHolders, type BookTable } from "./books.ts";

const headers = ["系統ID", "書名", "主條碼", "ISBN", "保管人"];

function table(...rows: unknown[][]): BookTable {
  return { headers, rows };
}

test("reports missing required columns", () => {
  assert.deepEqual(missingRequired(["主條碼", "書名"]), ["保管人"]);
  assert.throws(() => buildCatalog({ headers: ["書名"], rows: [] }, "v", 0), /主條碼、保管人/);
});

test("catalog finds columns by header and keeps barcodes as text", () => {
  const t = table([1, "蝴蝶", "000070", "978", "學校"], [2, " 恐龍 ", " 200116 ", "", "彩虹"]);
  assert.deepEqual(buildCatalog(t, "v1", 7), {
    version: "v1",
    seq: 7,
    books: [
      ["000070", "蝴蝶", "學校"],
      ["200116", "恐龍", "彩虹"],
    ],
  });
});

test("catalog skips rows without a barcode and keeps the first of duplicates", () => {
  const t = table([1, "", "", "", "學校"], [2, "A", "100", "", "學校"], [3, "B", "100", "", "彩虹"]);
  assert.deepEqual(buildCatalog(t, "v", 0).books, [["100", "A", "學校"]]);
  assert.deepEqual([...bookIndex(t)], [["100", 1]]);
});

test("checkBooks lists rows a person has to fix", () => {
  const t = table(
    [1, "A", "100", "", "學校"],
    [2, "B", "100", "", "學校"],
    [3, "C", 70, "", "學校"],
    [4, "D", "200", "", "雲朵"],
    [5, "E", "300", "", ""],
    [6, "F", "", "", "學校"],
    [7, "", "", "", ""],
  );
  assert.deepEqual(
    checkBooks(t, ["學校", "彩虹"]).map((i) => [i.row, i.problem]),
    [
      [3, "條碼與第 2 列重複"],
      [4, "條碼是數字格式，開頭的 0 可能已遺失"],
      [5, "保管人「雲朵」不在清單裡"],
      [6, "沒有保管人"],
      [7, "沒有條碼"],
    ],
  );
});

test("holder list always starts with the school", () => {
  assert.deepEqual(parseHolders(" 彩虹，海洋, 彩虹 、雲朵\n"), ["學校", "彩虹", "海洋", "雲朵"]);
  assert.deepEqual(parseHolders("彩虹, 學校"), ["學校", "彩虹"]);
  assert.deepEqual(parseHolders(""), ["學校"]);
});
