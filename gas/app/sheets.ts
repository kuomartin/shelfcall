// 試算表的分頁結構：Books（人維護的書目）與移交紀錄（程式寫入、只增不改）。

import { CODE_FIELD, type BookTable } from "../../core/books.ts";

export const BOOKS_SHEET = "Books";
export const LOG_SHEET = "移交紀錄";
export const LOG_HEADERS = ["seq", "scanId", "時間", CODE_FIELD, "書名", "從", "到", "入口"];
export const DATETIME_FORMAT = "yyyy/mm/dd hh:mm:ss";

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

function spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  return SpreadsheetApp.getActiveSpreadsheet();
}

export function booksSheet(): Sheet {
  const sheet = spreadsheet().getSheetByName(BOOKS_SHEET);
  if (!sheet) throw new Error(`找不到「${BOOKS_SHEET}」分頁`);
  return sheet;
}

export function readBooks(): BookTable {
  const [headers = [], ...rows] = booksSheet().getDataRange().getValues();
  return { headers: headers.map((h) => String(h).trim()), rows };
}

export function ensureLogSheet(): Sheet {
  const existing = spreadsheet().getSheetByName(LOG_SHEET);
  if (existing) return existing;
  const sheet = spreadsheet().insertSheet(LOG_SHEET);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
  sheet.getRange("C:C").setNumberFormat(DATETIME_FORMAT);
  // 主條碼保持文字，000070 才不會變成 70。
  sheet.getRange("D:D").setNumberFormat("@");
  sheet.setFrozenRows(1);
  return sheet;
}

/** 1 起算的欄號轉成 A1 的欄名。 */
export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
