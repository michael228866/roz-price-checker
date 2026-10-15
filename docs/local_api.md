# 本地行情 API

服務由 Electron 啟動，綁定 `127.0.0.1` 隨機連接埠。只接受同一 Host 與 Origin 的 GET。所有資料來自本機 SQLite；本地查詢不會呼叫 GNJOY。

| 路徑 | 內容 |
| --- | --- |
| `GET /api/health` | 服務健康狀態 |
| `GET /api/market/summary` | 商品、掛單、待確認候選與同步摘要 |
| `GET /api/items?q=&limit=&cursor=` | 商品名稱模糊搜尋，依最低開價排序；`limit` 最大 100 |
| `GET /api/items/:id/listings?limit=&cursor=` | 規格指紋下的掛單、來源、觀測時間與驗證座標 |
| `GET /api/items/:id/history?range=7d` | 1、7 或 30 天的開價與可信成交資料 |
| `GET /api/alerts?limit=&cursor=` | 警報及待確認候選 |
| `GET /api/sync/status` | IDLE、SYNCING、PAUSED_CHALLENGE、AUTH_REQUIRED 等狀態 |
| `GET /api/sources` | 來源類型、授權與啟用狀態，不包含授權依據文字 |
| `GET /api/coverage` | 已知索引與掃描覆蓋數量；不代表全市場覆蓋 |

`cursor` 是從零開始的穩定排序偏移。錯誤輸入回傳 400；未公開路徑回傳 404；非 GET 回傳 405。API 不包含 Cookie、Webhook 或登入資料。舊資料未保存完整規格欄位時，`specification` 會是 `null`，仍以原有規格指紋區分。`VERIFIED_ACTIVE_OBSERVATION` 只表示本地暫存的完整頁組觀測尚在有效期限內，不保證商品仍可購買。

正式 GNJOY 登入、驗證流程及 Discord 真實送達仍為 `LIVE_UNVERIFIED`。
