// 試算表的分頁結構：Books 與幼兒（人維護）、異動紀錄與借閱紀錄（程式寫入）。

import { CODE_FIELD, ROSTER_CLASS_FIELD, ROSTER_NAME_FIELD, ROSTER_SEAT_FIELD, type Table } from "../../core/books.ts";

export const BOOKS_SHEET = "Books";
export const ROSTER_SHEET = "幼兒";
export const LOG_SHEET = "異動紀錄";
export const LOG_HEADERS = ["seq", "scanId", "時間", CODE_FIELD, "書名", "動作", "從", "到", "借閱班級", "借閱人", "入口"];
export const LOAN_SHEET = "借閱紀錄";
/** 只增不改：歸還時只填歸還日期與備註。借閱編號是借閱那一筆異動的 scanId。 */
export const LOAN_HEADERS = ["借閱編號", CODE_FIELD, "書名", "借閱班級", "借閱人", "借閱日期", "歸還日期", "備註"];
export const DATETIME_FORMAT = "yyyy/mm/dd hh:mm:ss";
export const DATE_FORMAT = "yyyy/mm/dd";

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

function spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  return SpreadsheetApp.getActiveSpreadsheet();
}

export function booksSheet(): Sheet {
  const sheet = spreadsheet().getSheetByName(BOOKS_SHEET);
  if (!sheet) throw new Error(`找不到「${BOOKS_SHEET}」分頁`);
  return sheet;
}

function readTable(sheet: Sheet): Table {
  const [headers = [], ...rows] = sheet.getDataRange().getValues();
  return { headers: headers.map((h) => String(h).trim()), rows };
}

export function readBooks(): Table {
  return readTable(booksSheet());
}

export function readRoster(): Table {
  return readTable(ensureSheet(ROSTER_SHEET, [ROSTER_CLASS_FIELD, ROSTER_SEAT_FIELD, ROSTER_NAME_FIELD]));
}

function ensureSheet(name: string, headers: string[], setup?: (sheet: Sheet) => void): Sheet {
  const existing = spreadsheet().getSheetByName(name);
  if (existing) return existing;
  const sheet = spreadsheet().insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  setup?.(sheet);
  return sheet;
}

export function ensureLogSheet(): Sheet {
  return ensureSheet(LOG_SHEET, LOG_HEADERS, (sheet) => {
    sheet.getRange("C:C").setNumberFormat(DATETIME_FORMAT);
    // 主條碼保持文字，000070 才不會變成 70。
    sheet.getRange("D:D").setNumberFormat("@");
  });
}

export function ensureLoanSheet(): Sheet {
  return ensureSheet(LOAN_SHEET, LOAN_HEADERS, (sheet) => {
    sheet.getRange("A:B").setNumberFormat("@");
    sheet.getRange("F:G").setNumberFormat(DATE_FORMAT);
  });
}

/** 1 起算的欄號轉成 A1 的欄名。 */
export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
