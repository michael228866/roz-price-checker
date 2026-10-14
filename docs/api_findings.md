# 網站操作驗證狀態

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 官方頁面有伺服器、類型、關鍵字及結果表格 | 公開頁面可見 | 不代表自動掃描成功 |
| `forAjax_shopDeal` 回應樣本解析 | FIXTURE_VERIFIED | 使用規格文件的去識別化欄位模型及離線測試 |
| 從正常 UI 搜尋擷取完整回應 | UNVERIFIED | 已實作監聽與保守配對，需登入後現場測試 |
| `div_storetype=2` 對應販售 | UNVERIFIED | 不以此數值自動認定販售 |
| `dt2[0].count` 作為分頁總筆數 | SOURCE_VERIFIED／LIVE_UNVERIFIED | 公開頁面程式將其指定給 `dt_rows_max`；實際已登入回應尚未驗證 |
| 分頁步長及 `goPage(N)` | SOURCE_VERIFIED／LIVE_UNVERIFIED | 公開 `pagination4.js` 顯示每頁 30 筆、`row_start=1+30×(頁碼-1)`，並產生 `javascript:goPage(N)` 連結；已登入正式站的完整性仍待驗證 |
| `SSI2` 跨掃描穩定性 | UNVERIFIED | 不作唯一識別鍵 |
| 網站允許的自動查詢頻率 | UNVERIFIED | 遇驗證／限流即停止或暫停 |
| Discord 真實發送 | UNVERIFIED | 已用 mock 測試，需使用者自己的 Webhook |
| 商店座標欄位與正常 UI 流程 | SOURCE_VERIFIED | 公開頁原始碼顯示：點擊 `.shopName[SSI]` 後，`a_store` 使用 `SSI2` 呼叫 `forAjax_shopDeal_a_store`；詳情列提供 `mapName`、`xPos`、`yPos` |
| 商店座標實際回應 | UNVERIFIED | 尚未以已登入 Session 點擊真實商店驗證；解析與 SSI／商品／售價／數量配對已通過 mock 測試 |

公開來源：[官方露天商店查詢頁](https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch)、[官方分頁腳本](https://event.gnjoy.com.tw/js/Ro/RoShopSearch/pagination4.js?v=230904e)。來源碼可證明頁面設計，不能代替已登入的正式站實測。

位置查詢只在該商店列仍顯示且已符合低價門檻時，透過頁面原有的點擊事件執行。已確認候選但座標未取得時記為 `LOCATION_PENDING`，待下一次正常掃描補查；同一價格事件不重複發送 Discord。

部分頁面結果會保留為 `PARTIAL_PAGESET` 近期觀測，供使用者了解已看見的掛單；它們不進入目前有效開價的異常基準。歷史開價與成交紀錄仍分開保存，成交價目前沒有可信的正式站擷取流程。

未確認資料的商品索引覆蓋率及搜尋完整性均為 **UNKNOWN**。系統不能宣稱全伺服器覆蓋。
