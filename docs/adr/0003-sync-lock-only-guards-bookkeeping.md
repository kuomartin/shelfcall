# 同步時 lock 只保護記帳，寫試算表在放開 lock 之後

每次同步在 script lock 內只做記帳：依 scanId 去重、分配 seq、預留異動紀錄與借閱紀錄上不重疊的列範圍，在 CacheService 記下近期紀錄、已見過的 scanId、每冊最新的 seq，在 Script Properties 記下每冊最近一次借閱；放開 lock 後才寫異動紀錄、借閱紀錄與 Books。在同樣架構的報到系統上實測，lock 內讀寫試算表一次要持有約 1.3 秒，8 個入口同時同步就排隊到逾時；只記帳時持有時間 p50 約 0.3 秒。

寫 Books 前比對快取裡這一冊最新的 seq，已被更新的異動取代就不寫。兩批同步放開 lock 後的寫入順序可能顛倒，不比對的話舊的狀態會蓋掉新的。

## Considered Options

- **在 lock 內寫 Books**：沒有任何競態，但持有時間回到 1 秒以上。比對與寫入之間的空窗只有幾十毫秒，而且只在兩個入口幾乎同時刷同一冊時才有影響，不值得。

## Consequences

- 已見過的 scanId 與每冊最新的 seq 存在 CacheService：快取被清掉後重送的異動可能多寫一列，比對也可能失效。重送的異動結果相同，所以接受。
- 每冊最近一次借閱存在 Script Properties，不放 CacheService：借閱可能開好幾週，CacheService 最多保留 6 小時。
- 預留的列範圍若不是空的（有人手動插入或刪除了列），那一批改在 lock 內接在最後一列之後寫，並校正計數器。
- 同步回應的 `entries` 只涵蓋最近 300 筆。
