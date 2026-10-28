// doPost 的動作：bootstrap、sync。

import type { ApiRequest, BootstrapResult, SyncResult } from "../../core/api.ts";
import { buildCatalog } from "../../core/books.ts";
import { applySync, type SyncRequest, type SyncResponse } from "../../core/sync.ts";
import { catalogVersion, getHolders } from "./settings.ts";
import { readBooks } from "./sheets.ts";
import { catalogSeq, DeferredHolderStore, LockedLogStore, writeHolders, writeReservation } from "./store.ts";

const LOCK_WAIT_MS = 20_000;

/** seq 要在讀 Books 之前取得：之後才記帳的移交，掃描頁會自己套上去。 */
function bootstrap(): BootstrapResult {
  const seq = catalogSeq();
  const version = catalogVersion();
  return { holders: getHolders(), catalog: buildCatalog(readBooks(), version, seq) };
}

/** 只在 --dev 建置記錄各段耗時，隨回應帶回。 */
function timer(): { mark(label: string): void; result(): Record<string, number> | undefined } {
  const marks: Record<string, number> = {};
  let last = Date.now();
  return {
    mark(label) {
      if (!__DEV__) return;
      const now = Date.now();
      marks[label] = now - last;
      last = now;
    },
    result: () => (__DEV__ ? marks : undefined),
  };
}

function sync(req: SyncRequest): SyncResult {
  const t = timer();
  const holders = getHolders();
  const unknown = [...new Set(req.transfers.map((x) => x.to))].filter((h) => !holders.includes(h));
  if (unknown.length) throw new Error(`未知的保管人：${unknown.join("、")}，請重新整理掃描頁`);

  const deferred = new DeferredHolderStore();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  t.mark("lockWait");
  let store: LockedLogStore;
  let res: SyncResponse;
  try {
    store = new LockedLogStore(req.transfers.map((x) => x.scanId));
    res = applySync(store, deferred, req);
  } finally {
    lock.releaseLock();
  }
  t.mark("locked");
  if (store.reservation) {
    const books = readBooks();
    t.mark("readBooks");
    writeReservation(store.reservation, books);
    writeHolders(deferred.entries, books);
    t.mark("write");
  }
  return { ...res, catalogVersion: catalogVersion(), ...(__DEV__ ? { timings: t.result() } : {}) };
}

export function handle(req: ApiRequest): unknown {
  switch (req.action) {
    case "bootstrap":
      return bootstrap();
    case "sync":
      return sync(req);
  }
}
