# 網站操作驗證狀態

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 官方頁面有伺服器、類型、關鍵字及結果表格 | 公開頁面可見 | 不代表自動掃描成功 |
| `forAjax_shopDeal` 回應樣本解析 | FIXTURE_VERIFIED | 使用規格文件的去識別化欄位模型及離線測試 |
| 從正常 UI 搜尋擷取完整回應 | UNVERIFIED | 已實作監聽與保守配對，需登入後現場測試 |
| `div_storetype=2` 對應販售 | UNVERIFIED | 不以此數值自動認定販售 |
| `dt2[0].count` 為完整總筆數 | UNVERIFIED | 僅原樣保存為報告值 |
| 正式網站分頁與 `row_start` | UNVERIFIED | 目前只分析可見第一頁 |
| `SSI2` 跨掃描穩定性 | UNVERIFIED | 不作唯一識別鍵 |
| 網站允許的自動查詢頻率 | UNVERIFIED | 遇驗證／限流即停止或暫停 |
| Discord 真實發送 | UNVERIFIED | 已用 mock 測試，需使用者自己的 Webhook |

未確認資料的商品索引覆蓋率及搜尋完整性均為 **UNKNOWN**。系統不能宣稱全伺服器覆蓋。
