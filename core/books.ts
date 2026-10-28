// Books 分頁：掃描頁的書目快取與書目檢查。依標題名稱找欄位，不依位置。

export const CODE_FIELD = "主條碼";
export const TITLE_FIELD = "書名";
export const HOLDER_FIELD = "保管人";
export const UPDATED_FIELD = "更新時間";
export const REQUIRED_FIELDS = [CODE_FIELD, TITLE_FIELD, HOLDER_FIELD];
export const DEFAULT_HOLDER = "學校";

/** Books 分頁的原始內容：第 1 列標題，其後每列一冊。 */
export interface BookTable {
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
}

/** [主條碼, 書名, 保管人]：用陣列而不是物件，3,000 冊的快取少一半大小。 */
export type CatalogBook = [code: string, title: string, holder: string];

export interface Catalog {
  version: string;
  /** 讀取 Books 之前的 seq；seq 更大的移交還沒反映在 books 裡。 */
  seq: number;
  books: CatalogBook[];
}

export function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function missingRequired(headers: readonly string[]): string[] {
  return REQUIRED_FIELDS.filter((f) => !headers.includes(f));
}

function columns(table: BookTable): { code: number; title: number; holder: number } {
  const missing = missingRequired(table.headers);
  if (missing.length) throw new Error(`Books 分頁缺少欄位：${missing.join("、")}`);
  return {
    code: table.headers.indexOf(CODE_FIELD),
    title: table.headers.indexOf(TITLE_FIELD),
    holder: table.headers.indexOf(HOLDER_FIELD),
  };
}

/** 沒有條碼的列略過；條碼重複時以第一列為準（檢查書目會列出來）。 */
export function buildCatalog(table: BookTable, version: string, seq: number): Catalog {
  const col = columns(table);
  const seen = new Set<string>();
  const books: CatalogBook[] = [];
  for (const row of table.rows) {
    const code = text(row[col.code]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    books.push([code, text(row[col.title]), text(row[col.holder])]);
  }
  return { version, seq, books };
}

/** 主條碼 → 資料列索引（0 起算，不含標題列）。 */
export function bookIndex(table: BookTable): Map<string, number> {
  const col = columns(table).code;
  const index = new Map<string, number>();
  table.rows.forEach((row, i) => {
    const code = text(row[col]);
    if (code && !index.has(code)) index.set(code, i);
  });
  return index;
}

export interface BookIssue {
  /** 試算表上的列號（標題列是第 1 列）。 */
  row: number;
  code: string;
  title: string;
  problem: string;
}

/**
 * 列出需要人處理的列。條碼存成數字時，開頭的 0 已經被試算表吃掉，刷 000070 會找不到存成 70 的書。
 * 書名和條碼都空白的列視為空列，不列出。
 */
export function checkBooks(table: BookTable, holders: readonly string[]): BookIssue[] {
  const col = columns(table);
  const first = new Map<string, number>();
  const issues: BookIssue[] = [];
  table.rows.forEach((row, i) => {
    const raw = row[col.code];
    const code = text(raw);
    const title = text(row[col.title]);
    const holder = text(row[col.holder]);
    const at = { row: i + 2, code, title };
    if (!code) {
      if (title || holder) issues.push({ ...at, problem: "沒有條碼" });
      return;
    }
    if (first.has(code)) issues.push({ ...at, problem: `條碼與第 ${first.get(code)} 列重複` });
    else first.set(code, i + 2);
    if (typeof raw === "number") issues.push({ ...at, problem: "條碼是數字格式，開頭的 0 可能已遺失" });
    if (!holders.includes(holder)) issues.push({ ...at, problem: holder ? `保管人「${holder}」不在清單裡` : "沒有保管人" });
  });
  return issues;
}

/** 設定裡的保管人清單：逗號分隔、去重；「學校」一定在第一個，因為還書就是移交給學校。 */
export function parseHolders(input: string): string[] {
  const names = input.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([DEFAULT_HOLDER, ...names])];
}
