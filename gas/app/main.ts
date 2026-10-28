// Apps Script 進入點。建置時，這裡 export 的函式會成為頂層函式。

import { parseRequest, type ApiResponse } from "../../core/api.ts";
import { checkBooks, parseHolders } from "../../core/books.ts";
import { handle } from "./api.ts";
import { devHandle } from "./dev.ts";
import { bumpCatalogVersion, deploymentId, getHolders, saveHolders, storeDeploymentId } from "./settings.ts";
import { BOOKS_SHEET, ensureLogSheet, readBooks } from "./sheets.ts";
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

/** simple trigger：Books 被手動編輯時，讓各裝置重抓書目快取。script 自己的寫入不會觸發。 */
export function onEdit(e: GoogleAppsScript.Events.SheetsOnEdit): void {
  if (e.range.getSheet().getName() === BOOKS_SHEET) bumpCatalogVersion();
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

export function loadHolders(): string[] {
  return getHolders();
}

export function storeHolders(text: string): string[] {
  const holders = parseHolders(text);
  saveHolders(holders);
  return holders;
}

export function showCheck(): void {
  const html = HtmlService.createHtmlOutput(checkDialog(checkBooks(readBooks(), getHolders())));
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(720).setHeight(520), "檢查書目");
}
