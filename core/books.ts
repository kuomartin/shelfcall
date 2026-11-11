// Books 分頁與幼兒分頁：掃描頁的書目快取、幼兒名單與書目檢查。依標題名稱找欄位，不依位置。

export const CODE_FIELD = "主條碼";
export const TITLE_FIELD = "書名";
export const LOCATION_FIELD = "位置";
export const LOAN_CLASS_FIELD = "借閱班級";
export const BORROWER_FIELD = "借閱人";
export const LOANED_AT_FIELD = "借閱日期";
export const STATUS_FIELD = "狀態";
export const UPDATED_FIELD = "更新時間";
export const REQUIRED_FIELDS = [CODE_FIELD, TITLE_FIELD, LOCATION_FIELD, LOAN_CLASS_FIELD, BORROWER_FIELD, LOANED_AT_FIELD, STATUS_FIELD];

export const SCHOOL = "學校";
/** 借閱中的書的位置。保留字，不能當班級名稱。 */
export const ON_LOAN = "借出中";

export const ROSTER_CLASS_FIELD = "班級";
export const ROSTER_NAME_FIELD = "姓名";
export const ROSTER_SEAT_FIELD = "座號";

/** 第 1 列是標題、其後每列一筆的分頁內容。 */
export interface Table {
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
}

/** [主條碼, 書名, 位置, 借閱班級, 借閱人, 借閱時間 epoch ms（沒有借閱為 0）]：用陣列而不是物件，3,000 冊的快取少一半大小。 */
export type CatalogBook = [code: string, title: string, location: string, loanClass: string, borrower: string, loanedAt: number];

export interface Catalog {
  version: string;
  /** 讀取 Books 之前的 seq；seq 更大的異動還沒反映在 books 裡。 */
  seq: number;
  books: CatalogBook[];
}

/** 班級 → 幼兒姓名，依座號排序；沒有座號的排在後面，依分頁上的順序。 */
export type Roster = Record<string, string[]>;

export function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** 由位置決定，寫進 Books 的狀態欄方便篩選。 */
export function statusOf(location: string): string {
  if (location === SCHOOL) return "在館";
  if (location === ON_LOAN) return "幼兒借閱中";
  return location ? "班級使用中" : "";
}

export function missingRequired(headers: readonly string[]): string[] {
  return REQUIRED_FIELDS.filter((f) => !headers.includes(f));
}

function columns(table: Table) {
  const missing = missingRequired(table.headers);
  if (missing.length) throw new Error(`Books 分頁缺少欄位：${missing.join("、")}`);
  const at = (f: string) => table.headers.indexOf(f);
  return {
    code: at(CODE_FIELD),
    title: at(TITLE_FIELD),
    location: at(LOCATION_FIELD),
    loanClass: at(LOAN_CLASS_FIELD),
    borrower: at(BORROWER_FIELD),
    loanedAt: at(LOANED_AT_FIELD),
  };
}

function epoch(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

/** 沒有條碼的列略過；條碼重複時以第一列為準（檢查書目會列出來）。 */
export function buildCatalog(table: Table, version: string, seq: number): Catalog {
  const col = columns(table);
  const seen = new Set<string>();
  const books: CatalogBook[] = [];
  for (const row of table.rows) {
    const code = text(row[col.code]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const borrower = text(row[col.borrower]);
    books.push([
      code,
      text(row[col.title]),
      text(row[col.location]),
      borrower ? text(row[col.loanClass]) : "",
      borrower,
      borrower ? epoch(row[col.loanedAt]) : 0,
    ]);
  }
  return { version, seq, books };
}

/** 主條碼 → 資料列索引（0 起算，不含標題列）。 */
export function bookIndex(table: Table): Map<string, number> {
  const col = columns(table).code;
  const index = new Map<string, number>();
  table.rows.forEach((row, i) => {
    const code = text(row[col]);
    if (code && !index.has(code)) index.set(code, i);
  });
  return index;
}

function rosterColumns(table: Table): { cls: number; name: number; seat: number } {
  const cls = table.headers.indexOf(ROSTER_CLASS_FIELD);
  const name = table.headers.indexOf(ROSTER_NAME_FIELD);
  if (cls === -1 || name === -1) throw new Error(`幼兒分頁缺少欄位：${ROSTER_CLASS_FIELD}、${ROSTER_NAME_FIELD}`);
  return { cls, name, seat: table.headers.indexOf(ROSTER_SEAT_FIELD) };
}

/** 只收清單裡的班級；同班同名只留一個（檢查書目會列出來）。 */
export function buildRoster(table: Table, classes: readonly string[]): Roster {
  const col = rosterColumns(table);
  const byClass = new Map<string, { name: string; seat: number; i: number }[]>();
  table.rows.forEach((row, i) => {
    const cls = text(row[col.cls]);
    const name = text(row[col.name]);
    if (!name || cls === SCHOOL || !classes.includes(cls)) return;
    const list = byClass.get(cls) ?? [];
    if (list.some((c) => c.name === name)) return;
    const seat = col.seat === -1 ? NaN : Number(text(row[col.seat]) || NaN);
    list.push({ name, seat: Number.isFinite(seat) ? seat : Infinity, i });
    byClass.set(cls, list);
  });
  return Object.fromEntries(
    [...byClass].map(([cls, list]) => [cls, list.sort((a, b) => a.seat - b.seat || a.i - b.i).map((c) => c.name)]),
  );
}

export interface Issue {
  sheet: string;
  /** 試算表上的列號（標題列是第 1 列）。 */
  row: number;
  /** 這一列是什麼：Books 是主條碼與書名，幼兒是班級與姓名。 */
  label: string;
  problem: string;
}

/**
 * 列出需要人處理的列。條碼存成數字時，開頭的 0 已經被試算表吃掉，刷 000070 會找不到存成 70 的書。
 * 書名和條碼都空白的列視為空列，不列出。
 */
export function checkBooks(table: Table, classes: readonly string[]): Issue[] {
  const col = columns(table);
  const first = new Map<string, number>();
  const issues: Issue[] = [];
  table.rows.forEach((row, i) => {
    const raw = row[col.code];
    const code = text(raw);
    const title = text(row[col.title]);
    const location = text(row[col.location]);
    const loanClass = text(row[col.loanClass]);
    const borrower = text(row[col.borrower]);
    const add = (problem: string) => issues.push({ sheet: "Books", row: i + 2, label: [code, title].filter(Boolean).join(" "), problem });
    if (!code) {
      if (title || location) add("沒有條碼");
      return;
    }
    if (first.has(code)) add(`條碼與第 ${first.get(code)} 列重複`);
    else first.set(code, i + 2);
    if (typeof raw === "number") add("條碼是數字格式，開頭的 0 可能已遺失");
    if (!location) add("沒有位置");
    else if (location !== ON_LOAN && !classes.includes(location)) add(`位置「${location}」不在班級清單裡`);
    if (location === ON_LOAN && !borrower) add("位置是借出中，但沒有借閱人");
    if (location !== ON_LOAN && borrower) add("有借閱人，但位置不是借出中");
    if (borrower && !classes.includes(loanClass)) add(loanClass ? `借閱班級「${loanClass}」不在班級清單裡` : "有借閱人，但沒有借閱班級");
  });
  return issues;
}

export function checkRoster(table: Table, classes: readonly string[]): Issue[] {
  const col = rosterColumns(table);
  const first = new Map<string, number>();
  const issues: Issue[] = [];
  table.rows.forEach((row, i) => {
    const cls = text(row[col.cls]);
    const name = text(row[col.name]);
    if (!cls && !name) return;
    const add = (problem: string) => issues.push({ sheet: "幼兒", row: i + 2, label: [cls, name].filter(Boolean).join(" "), problem });
    if (!name) add("沒有姓名");
    if (!cls) add("沒有班級");
    else if (cls === SCHOOL || !classes.includes(cls)) add(`班級「${cls}」不在班級清單裡`);
    if (!cls || !name) return;
    const key = `${cls}\n${name}`;
    if (first.has(key)) add(`與第 ${first.get(key)} 列同班同名`);
    else first.set(key, i + 2);
  });
  return issues;
}

/** 設定裡的班級清單：逗號分隔、去重；「學校」一定在第一個，「借出中」是保留字。 */
export function parseClasses(input: string): string[] {
  const names = input.split(/[,，、\n]/).map((s) => s.trim()).filter((s) => s && s !== ON_LOAN);
  return [...new Set([SCHOOL, ...names])];
}
