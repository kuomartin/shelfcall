// 只在 `npm run build -- --dev` 的建置裡存在：讓端到端測試能清空異動紀錄與借閱紀錄、讀回寫入結果。
// 正式建置時 __DEV__ 為 false，doPost 不會呼叫這裡，esbuild 會把整段移除。

import { bookIndex, BORROWER_FIELD, LOAN_CLASS_FIELD, LOANED_AT_FIELD, LOCATION_FIELD, STATUS_FIELD, UPDATED_FIELD } from "../../core/books.ts";
import { saveClasses } from "./settings.ts";
import { ensureLoanSheet, ensureLogSheet, readBooks } from "./sheets.ts";
import { resetLog } from "./store.ts";

const FIELDS = [LOCATION_FIELD, LOAN_CLASS_FIELD, BORROWER_FIELD, LOANED_AT_FIELD, STATUS_FIELD, UPDATED_FIELD];

/** 讀回異動紀錄與借閱紀錄全部，以及指定條碼在 Books 上的狀態欄位。 */
function dump(codes: string[]): unknown {
  const books = readBooks();
  const index = bookIndex(books);
  return {
    log: ensureLogSheet().getDataRange().getDisplayValues(),
    loans: ensureLoanSheet().getDataRange().getDisplayValues(),
    books: Object.fromEntries(
      codes.map((code) => {
        const row = books.rows[index.get(code) ?? -1];
        const fields = FIELDS.filter((f) => books.headers.includes(f)).map((f) => [f, String(row?.[books.headers.indexOf(f)] ?? "")]);
        return [code, row ? Object.fromEntries(fields) : null];
      }),
    ),
  };
}

export function devHandle(body: unknown): unknown {
  const b = body as { action?: string; codes?: string[]; classes?: string[] };
  if (b.action === "devReset") {
    resetLog();
    if (b.classes) saveClasses(b.classes);
    return { reset: true };
  }
  if (b.action === "devDump") return dump(b.codes ?? []);
  return undefined;
}
