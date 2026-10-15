# ROZ 露天價格監控

沿用 Electron 瀏覽器視窗操作[官方露天商店查詢頁](https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch)。使用者自行登入並完成網站驗證；程式不製造或重放驗證值。掃描只會在使用者按「開始定時掃描」後啟動。程式不購買商品。

## 啟動

需要 Node.js 22.18+。在 Windows PowerShell 執行：

```powershell
npm.cmd install
npm.cmd start
```

1. 按「開啟查詢頁／登入」，在官方視窗中親自登入並完成驗證。
2. 輸入每行一個關鍵字。需要商品索引時，匯入 CSV 並勾選「加入商品索引」。
3. 設定低價門檻與掃描間隔後按「開始定時掃描」。預設 10 分鐘；可設定 5–120 分鐘。每個關鍵字間隔至少 3 秒，單輪最多 20 個關鍵字。這些設定不代表網站允許該頻率，應遵守站方要求。
4. 若網站再次要求驗證，掃描暫停並切到官方視窗。親自處理後按「驗證完成，繼續」。遇到網站限流時請停止使用，確認站方允許的方式與頻率後再操作。

## V2 本地行情中心

Electron 啟動後按「開啟本地行情中心」，系統瀏覽器會開啟自動分配連接埠的 `127.0.0.1` 網站。網站只讀取現有本機 SQLite，不會觸發 GNJOY 搜尋。提供市場總覽、商品搜尋、掛單與歷史開價、警報中心；來源及觀測時間會在查詢結果顯示。網站不提供掃描或匯入寫入端點。關閉 Electron 後本地網站停止。

`ROZ_FRESHNESS_MINUTES` 可調整本地「最近觀測」顯示門檻，範圍 1–1440 分鐘，預設 15 分鐘。此狀態不保證掛單仍在販售。

「授權行情檔案匯入」須由使用者提供來源 ID、授權依據及 CSV／JSON 檔案。檔案大小上限 5 MB、單次 50000 列。JSON 為物件陣列；CSV 第一列為欄名。必要欄位：`serverId,itemName,shop,price,quantity,storeType,observedAt,sourceListingId,sourceId`。`serverId` 必須為 529，`storeType` 必須為 `販售`，時間格式為 UTC ISO 8601。完整規格欄位：`itemRefining,ItemGradeLevel,DefaultSlotCount,slot_1,slot_2,slot_3,slot_4,RandomOpt1,RandomOpt2,RandomOpt3,RandomOpt4,RandomOpt5`。缺少完整規格的資料會保存，但不會參與精確規格候選分析。匯入座標不會被當成官方驗證位置。

```csv
serverId,itemName,shop,price,quantity,storeType,itemRefining,ItemGradeLevel,DefaultSlotCount,slot_1,slot_2,slot_3,slot_4,RandomOpt1,RandomOpt2,RandomOpt3,RandomOpt4,RandomOpt5,observedAt,sourceListingId,sourceId
529,魔靈石,範例商店,100,1,販售,0,0,0,0,0,0,0,0,0,0,0,0,2026-10-15T00:00:00Z,example-1,my-export
```

匯入會回報拒絕列與原因；同來源、相同內容的檔案不會再次匯入。匯入觀測與掃描觀測使用同一個 SQLite Store 寫入。匯入資料可能進入待確認候選，不會直接產生 Discord 正式低價通知。官方 API 來源預設為 `AUTHORIZATION_REQUIRED`，不會自動啟用。

若不同授權來源有共同且可靠的掛單識別，可選填 `canonicalListingId`。相同商店、完整規格與 `canonicalListingId` 會共用本地掛單身份；原始來源與各自的 `sourceListingId` 仍保留在來源觀測表。未提供共同 ID 時不猜測跨來源是否為同筆掛單，行情比較仍會按獨立賣家去重。

檔案解析與批次寫入在單一 Worker 中完成。匯入期間會暫停新的掃描、索引寫入及通知重試；本地行情網站仍可查詢已提交的資料。

Discord 發送前會將通知標記為 `sending`。若程序在發送與回寫間中斷，下次啟動會標記為 `uncertain`，停止自動重送。請先確認 Discord 是否已收到，再於 Electron 輸入警報 ID，使用「人工重試通知」。Discord 不提供本工具可用的絕對 exactly-once 保證。

完成掛單二次確認後若商店座標仍未取得，系統先保留約 60 秒供座標重試；逾時後可傳送通知並明確標示「尚未取得商店位置」，不猜測 `/navi`。

備份資料庫時請使用 SQLite 一致性備份工具，或先關閉 Electron 再複製使用者資料夾中的 `market.sqlite`。還原前先關閉 Electron，保存目前檔案副本，避免覆蓋較新的資料。不要單獨複製正在寫入的 WAL 主檔。

CSV 範例：

```csv
itemName,tier
紅辣椒蝦湯,P0
範例商品,P1
```

`tier` 可為 P0、P1、P2；目前依優先級排序並輪巡索引。匯入的商品索引只表示已知商品，沒有全伺服器覆蓋率保證。

Discord 通知：在介面貼上 Discord Webhook 網址，按「儲存通知設定」。程式使用 Electron `safeStorage` 加密後存於本機使用者資料夾；欄位不回填，Log 不記錄網址。按「移除 Webhook」可刪除設定。通知失敗會保留待送，後續掃描最多重試三次。尚未設定 Webhook 時，桌面提醒仍可用。

## 已實作與限制

- 以官方查詢頁正常 UI 搜尋指定關鍵字。監聽由 UI 操作產生的查詢回應，能明確配對到可見掛單時才補上完整商品規格；不自行拼造 AJAX 請求。
- 對完整規格使用 SHA-256 指紋分組，計算排除待測掛單與同店重複掛單的參考中位價。可見表格缺少卡片／附魔等規格時標記為低可信度，沿用原本的同名同 slot 提醒。
- SQLite 保存商品索引、掃描紀錄、掛單、逐輪觀測、行情基準與通知。資料庫、Log 和不含驗證值的掃描進度位於 Electron 使用者資料夾，不在專案內。掃描遇到驗證可由人工處理後續掃；按「停止」會清除本輪暫存進度。
- `paginator.cjs` 經官方頁面正常的 `goPage(N)` 控制逐頁擷取，單一關鍵字最多 20 頁。公開原始碼可確認每頁 30 筆、`row_start` 步長及 `dt2.count` 用於分頁；登入後的正式站回應仍為 `LIVE_UNVERIFIED`。超過上限、總筆數變動或頁面不完整時，已取得資料保存為低可信度觀測，不用作完整行情或低價通知。
- `div_storetype=2` 與回應 `storetype=0` 的含義尚未現場證實。只有 UI 明確顯示「販售」的掛單才進入行情分析。
- 不能宣稱完整市場掃描、永久免驗證或網站端實測成功。詳見 [驗證狀態](docs/api_findings.md)。

## 測試

```powershell
npm.cmd test
```

測試覆蓋離線回應解析、規格分組、價格分類、CSV、分頁完整性、SQLite 寫入、通知網址與驗證後續掃。實際登入、分頁與 Discord 發送需在使用者提供條件後驗證。
