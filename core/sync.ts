// 同步的伺服器端邏輯：去重、分配 seq、寫入移交紀錄、決定每冊的新保管人、回傳 cursor 之後的移交。
// 儲存透過 LogStore／HolderStore 兩個 port，Apps Script 端以 Sheet 實作，測試以記憶體實作。

/** 一筆移交，由掃描頁產生。scanId 重送時不變，讓寫入冪等。 */
export interface Transfer {
  scanId: string;
  code: string;
  /** 掃描頁刷書當下看到的保管人。 */
  from: string;
  to: string;
  /** epoch ms，以裝置時間為準。 */
  at: number;
}

/** 移交紀錄的一列。seq 單調遞增，是同步 cursor，也決定同一冊多筆移交的先後。 */
export interface LogEntry extends Transfer {
  seq: number;
  deviceId: string;
}

export interface SyncRequest {
  deviceId: string;
  /** 這台裝置已經看過的最大 seq。 */
  cursor: number;
  transfers: Transfer[];
}

export interface SyncResponse {
  cursor: number;
  /** 本次請求中已確定落地的 scanId，含先前已寫入的重送。前端據此移出佇列。 */
  acked: string[];
  /** cursor 之後的移交，含本次送出的：掃描頁要知道自己那幾筆的 seq，才能和其他入口的移交排序。 */
  entries: LogEntry[];
}

export interface LogStore {
  knownScanIds(ids: string[]): Set<string>;
  lastSeq(): number;
  append(entries: LogEntry[]): void;
  since(cursor: number): LogEntry[];
}

export interface HolderStore {
  /** 每冊只會收到本批 seq 最大的那一筆。 */
  setHolder(entry: LogEntry): void;
}

/** 呼叫端負責在呼叫期間持有寫入 lock。 */
export function applySync(log: LogStore, holders: HolderStore, req: SyncRequest): SyncResponse {
  const known = log.knownScanIds(req.transfers.map((t) => t.scanId));
  const fresh: LogEntry[] = [];
  let seq = log.lastSeq();
  for (const transfer of req.transfers) {
    if (known.has(transfer.scanId)) continue;
    known.add(transfer.scanId);
    fresh.push({ ...transfer, seq: ++seq, deviceId: req.deviceId });
  }
  if (fresh.length) log.append(fresh);

  const latest = new Map<string, LogEntry>();
  for (const entry of fresh) latest.set(entry.code, entry);
  for (const entry of latest.values()) holders.setHolder(entry);

  return {
    cursor: seq,
    acked: req.transfers.map((t) => t.scanId),
    entries: log.since(req.cursor),
  };
}
