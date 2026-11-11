// doPost 的動作：bootstrap、sync。

import { unknownTargets, type ApiRequest, type BootstrapResult, type SyncResult } from "../../core/api.ts";
import { buildCatalog, buildRoster } from "../../core/books.ts";
import { applySync, type SyncRequest, type SyncResponse } from "../../core/sync.ts";
import { catalogVersion, getClasses } from "./settings.ts";
import { readBooks, readRoster } from "./sheets.ts";
import { catalogSeq, DeferredBookStore, LockedStore, writeLoans, writeReservation, writeStates } from "./store.ts";

const LOCK_WAIT_MS = 20_000;

/** seq 要在讀 Books 之前取得：之後才記帳的異動，掃描頁會自己套上去。 */
function bootstrap(): BootstrapResult {
  const seq = catalogSeq();
  const version = catalogVersion();
  const classes = getClasses();
  return { classes, roster: buildRoster(readRoster(), classes), catalog: buildCatalog(readBooks(), version, seq) };
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
  const classes = getClasses();
  // 幼兒分頁只在有借閱時才讀。
  const roster = req.changes.some((c) => c.to.borrower) ? buildRoster(readRoster(), classes) : {};
  const unknown = unknownTargets(req.changes, classes, roster);
  if (unknown.length) throw new Error(`不在班級清單或幼兒名單裡：${unknown.join("、")}，請重新整理掃描頁`);

  const deferred = new DeferredBookStore();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  t.mark("lockWait");
  let store: LockedStore;
  let res: SyncResponse;
  try {
    store = new LockedStore(req.changes.map((c) => c.scanId));
    res = applySync(store, store, deferred, req);
    store.flush();
  } finally {
    lock.releaseLock();
  }
  t.mark("locked");
  if (store.reservation) {
    const books = readBooks();
    t.mark("readBooks");
    writeReservation(store.reservation, books);
    writeLoans(store.loanWrites, books);
    writeStates(deferred.entries, books);
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
