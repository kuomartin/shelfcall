// Apps Script 進入點。建置時，這裡 export 的函式會成為頂層函式。

import { parseRequest, type ApiResponse } from "../../core/api.ts";
import { checkBooks, checkRoster, parseClasses } from "../../core/books.ts";
import { handle } from "./api.ts";
import { devHandle } from "./dev.ts";
import { bumpCatalogVersion, deploymentId, getClasses, saveClasses, storeDeploymentId } from "./settings.ts";
import { BOOKS_SHEET, ensureLoanSheet, ensureLogSheet, readBooks, readRoster, ROSTER_SHEET } from "./sheets.ts";
import { checkDialog, NEED_SETUP, SETTINGS_DIALOG, setupPage, staffLinkDialog } from "./ui.ts";

function json(body: ApiResponse<unknown>): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 擁有者部署後開一次 Web App 網址，記下部署 ID。
 * ScriptApp.getService().getUrl() 只在 doGet/doPost 內可靠，選單裡呼叫會拿到錯的 ID。
 */
export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  const match = ScriptApp.getService().getUrl().match(/\/macros\/s\/([^/]+)\/exec/);
  if (match) storeDeploymentId(match[1]);
  ensureLogSheet();
  ensureLoanSheet();
  readRoster();
  return HtmlService.createHtmlOutput(setupPage(match ? match[1] : null)).setTitle("書籍保管");
}

export function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const body: unknown = JSON.parse(e.postData.contents);
    if (__DEV__) {
      const dev = devHandle(body);
      if (dev !== undefined) return json({ ok: true, data: dev });
    }
    return json({ ok: true, data: handle(parseRequest(body)) });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("保管")
    .addItem("工作人員連結", "showStaffLink")
    .addItem("設定", "showSettings")
    .addItem("檢查書目", "showCheck")
    .addToUi();
}

/** simple trigger：Books 或幼兒分頁被手動編輯時，讓各裝置重抓書目快取與幼兒名單。script 自己的寫入不會觸發。 */
export function onEdit(e: GoogleAppsScript.Events.SheetsOnEdit): void {
  const name = e.range.getSheet().getName();
  if (name === BOOKS_SHEET || name === ROSTER_SHEET) bumpCatalogVersion();
}

export function showStaffLink(): void {
  const id = deploymentId();
  const html = HtmlService.createHtmlOutput(id ? staffLinkDialog(id) : NEED_SETUP);
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(420).setHeight(420), "工作人員連結");
}

export function showSettings(): void {
  const html = HtmlService.createHtmlOutput(SETTINGS_DIALOG).setWidth(480).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, "設定");
}

export function loadClasses(): string[] {
  return getClasses();
}

export function storeClasses(text: string): string[] {
  const classes = parseClasses(text);
  saveClasses(classes);
  return classes;
}

export function showCheck(): void {
  const classes = getClasses();
  const issues = [...checkBooks(readBooks(), classes), ...checkRoster(readRoster(), classes)];
  const html = HtmlService.createHtmlOutput(checkDialog(issues));
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(720).setHeight(520), "檢查書目");
}
