// 只在 `npm run build -- --dev` 的建置裡存在：讓端到端測試能清空移交紀錄、讀回寫入結果。
// 正式建置時 __DEV__ 為 false，doPost 不會呼叫這裡，esbuild 會把整段移除。

import { bookIndex, HOLDER_FIELD, UPDATED_FIELD } from "../../core/books.ts";
import { saveHolders } from "./settings.ts";
import { ensureLogSheet, readBooks } from "./sheets.ts";
import { resetLog } from "./store.ts";

/** 讀回移交紀錄全部，以及指定條碼在 Books 上的保管人與更新時間。 */
function dump(codes: string[]): unknown {
  const books = readBooks();
  const index = bookIndex(books);
  const holder = books.headers.indexOf(HOLDER_FIELD);
  const updated = books.headers.indexOf(UPDATED_FIELD);
  return {
    log: ensureLogSheet().getDataRange().getDisplayValues(),
    books: Object.fromEntries(
      codes.map((code) => {
        const row = books.rows[index.get(code) ?? -1];
        return [code, row ? { holder: row[holder], updated: updated === -1 ? null : String(row[updated]) } : null];
      }),
    ),
  };
}

export function devHandle(body: unknown): unknown {
  const b = body as { action?: string; codes?: string[]; holders?: string[] };
  if (b.action === "devReset") {
    resetLog();
    if (b.holders) saveHolders(b.holders);
    return { reset: true };
  }
  if (b.action === "devDump") return dump(b.codes ?? []);
  return undefined;
}
