# ROZ Market Sniper V1.2 — Codex Production Implementation Prompt

> 請將本檔全文交給 Codex。目標是**直接建立、測試與交付可執行 Python 專案**，而非僅撰寫設計書。不得虛報網站端測試成功或宣稱已達成全伺服器覆蓋。

## 0. 任務與交付目標

你是一名資深 Python、Playwright、資料工程與行情監控工程師。請在目前工作目錄建立 `roz_market_sniper/`，實作針對台灣 RO 樂園露天商店的**異常低價警報系統**。

- 官方頁面：`https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch`
- 目標伺服器：西格倫（已觀察到 `div_svr=529`）
- 監控範圍：**販售掛單**，不是收購掛單；實際 `div_storetype` 含義仍需透過網站操作驗證。
- 目標：定期查詢允許取得的掛單，建立同規格行情基準，識別**約正常價 1/10、疑似少輸入一個 0**的掛單，向 Discord／Telegram 推送提醒。
- 優先支援 Windows 10/11、Python 3.12+；系統可在沒網路或未登入時以 fixtures 執行離線測試。
- 監控用途**不包含自動購買、自動搶購或任何交易執行**。

### 0.1 執行規則

1. 先檢查工作環境、現有專案、Git 狀態和 Python 版本，再建立檔案。
2. 直接完成程式碼、配置、測試、CLI、文件與簡單啟動指令；不要只產出規劃。
3. 缺少外部帳號登入、Discord／Telegram 憑證時，完成離線可測的所有功能，標示阻礙，不可停止整個開發。
4. 僅使用網站正常公開介面或取得授權的存取方式。不可破解／繞過 Turnstile、偽造或重放 CAPTCHA token、修改反機器人判斷、輪替代理以避開限制、偽造瀏覽器指紋或繞過存取控制。受阻就暫停並要求人工處理。
5. 不得將使用者先前貼出的 Cookie、`recaptcha`、`_Action`、Session、`token` 等值寫入程式、fixtures 或文件。
6. 不可預設空白搜尋、`%` 全域搜尋可用：使用者已實測均被拒絕。
7. 每個未驗證的網站行為須在 `docs/api_findings.md` 標記 `UNVERIFIED`；只有真實驗證後才可標記 `LIVE_VERIFIED`。
8. 不可自稱全伺服器 100% 掃描，除非已證明完整的商品母體與所有分頁均被取得。
9. 禁止執行無限掃描或高併發壓測。正式掃描必須由使用者明確啟動，遵守網站條款、頻率與回應限制。
10. 如修改既存 repo，保留無關變更；不要任意覆蓋使用者檔案。

## 1. 已知事實與待驗證事項

### 1.1 已知正常搜尋請求

使用者在 Chrome Network 看到了 `forAjax_shopDeal`，並提供正常搜尋時的參數名稱：

```json
{
  "div_svr": "529",
  "div_storetype": "2",
  "txb_KeyWord": "紅辣椒蝦湯",
  "row_start": "1",
  "sort_by": "itemPrice",
  "sort_desc": "",
  "_Action": "<由官方頁面提供的動態值>",
  "recaptcha": "<正常驗證流程生成的值>"
}
```

另看到了 `forAjax_Nd_recaptcha`、`forAjax_loadHotkeysSelf`，名稱可能分別涉及驗證與個人常用關鍵字，但尚未完成端到端確證。

**重要：上述僅供資料結構建模，程式不得自行拼造未授權 AJAX 請求或取得驗證值。** 優先 Playwright 真實可見瀏覽器，在使用者正常完成 Cloudflare 驗證與登入後，操作 UI 並觀察其正常回應。若站方不允許自動化則停止使用此來源。

### 1.2 已知正常搜尋回應（去除敏感識別碼的測試樣本）

```json
{
  "Message": null,
  "sdate": null,
  "edate": null,
  "dt": [
    {
      "storeName": "A",
      "itemRefining": 0,
      "itemName": "紅辣椒蝦湯",
      "slot_1": "",
      "slot_2": "",
      "slot_3": "",
      "slot_4": "",
      "ItemGradeLevel": 0,
      "DefaultSlotCount": "",
      "itemCNT": 1600,
      "itemPrice": 2000,
      "storetype": 0,
      "itemType": 1,
      "flag_240206a": "",
      "RandomOpt1": "",
      "RandomOpt2": "",
      "RandomOpt3": "",
      "RandomOpt4": "",
      "RandomOpt5": "",
      "SSI2": "<opaque-listing-value-1>"
    },
    {
      "storeName": "A I D",
      "itemRefining": 0,
      "itemName": "紅辣椒蝦湯",
      "slot_1": "",
      "slot_2": "",
      "slot_3": "",
      "slot_4": "",
      "ItemGradeLevel": 0,
      "DefaultSlotCount": "",
      "itemCNT": 700,
      "itemPrice": 2000,
      "storetype": 0,
      "itemType": 1,
      "flag_240206a": "",
      "RandomOpt1": "",
      "RandomOpt2": "",
      "RandomOpt3": "",
      "RandomOpt4": "",
      "RandomOpt5": "",
      "SSI2": "<opaque-listing-value-2>"
    }
  ],
  "dt2": [{"count": 2}],
  "token": "<opaque-response-value>"
}
```

`dt` 是可解析的掛單清單。`dt2[0].count` 疑似符合條件的總數，**尚待多頁測試確認**。`SSI2` 疑似識別欄位，但穩定性未知。回應的 `token` 不可視為可重複使用的授權憑證。請在 fixture 中保留欄位格式但用無效佔位值，並確保日誌不洩漏憑證。

### 1.3 已知搜尋限制

- 搜尋框空白：網站拒絕。
- 輸入單一 `%`：網站拒絕。
- 因此**不能將全市場掃描視為已實現**，要採用合法商品索引 + 分批查詢的模式。
- 不可藉由修改驗證流程或未公開參數規避搜尋限制。

### 1.4 仍需確認

- 第二頁 `row_start` 值、每頁筆數、最後一頁條件。
- `dt2[0].count` 是總筆數或其他統計。
- `div_storetype=2` 是否對應販售。
- 官網是否允許程式化定期擷取、頻率上限與相關條款。
- `SSI2` 在同一掛單跨不同掃描是否穩定。
- 能否合法取得完整商品名稱索引。
- 是否能從 UI 取得店鋪位置／商品位置；若不能，不得捏造。

## 2. 技術與專案結構

建議：Python 3.12+、Playwright、Pydantic 2、SQLAlchemy 2、SQLite (WAL)、APScheduler、httpx（僅用於通知或已授權資料來源）、pytest、pytest-asyncio、ruff、Rich、PyYAML、python-dotenv。

```text
roz_market_sniper/
├── pyproject.toml
├── requirements.txt
├── main.py
├── config.example.yaml
├── .env.example
├── .gitignore
├── README.md
├── src/roz_market_sniper/
│   ├── __init__.py
│   ├── cli.py
│   ├── config.py
│   ├── models.py
│   ├── browser.py
│   ├── ui_client.py
│   ├── parser.py
│   ├── paginator.py
│   ├── catalog.py
│   ├── search_planner.py
│   ├── database.py
│   ├── baselines.py
│   ├── anomalies.py
│   ├── listing_tracker.py
│   ├── scheduler.py
│   ├── notifier.py
│   ├── metrics.py
│   └── exceptions.py
├── data/.gitkeep
├── browser_profile/.gitkeep
├── tests/
│   ├── fixtures/shop_response.json
│   ├── test_parser.py
│   ├── test_paginator.py
│   ├── test_catalog.py
│   ├── test_baselines.py
│   ├── test_anomalies.py
│   ├── test_listing_tracker.py
│   ├── test_scheduler.py
│   └── test_notifier.py
└── docs/
    ├── architecture.md
    ├── api_findings.md
    ├── operations.md
    ├── limitations.md
    └── verification_report.md
```

使用 `pyproject.toml` 集中依賴與 lint/test 設定；`requirements.txt` 可以採用對應 pinned/locked 版本。模組以型別註記、清晰錯誤分類及依賴注入設計，禁止用單一巨型 `main.py`。

## 3. 瀏覽器、身份驗證和資料擷取

在 `browser.py` 實作 Playwright Persistent Context：

- `start_browser(headless=False)`：首次必須可見，使用隔離的專用 Profile。
- `open_shop_search()`：開啟官方頁面。
- `wait_for_manual_verification()`：讓真人正常完成 Turnstile 與登入，不寫自動破解方法。
- `check_session_state()`：分類 `READY`、`AUTH_REQUIRED`、`CHALLENGE_REQUIRED`、`BLOCKED`、`UNKNOWN`。
- `close_browser()`：正確釋放 context。

在 `ui_client.py` 實作：

- 從設定指定伺服器、商品關鍵字與可確認的販售選項。
- 透過可見、合法的 UI 操作觸發官方搜尋。
- 監聽由正常 UI 操作產生的 `forAjax_shopDeal` 回應，不攔截修改驗證值、不自行重放 CAPTCHA 資料。
- 使用 `parser.py` 將正常回應轉換為型別模型。
- UI selectors 集中管理，遇到介面變動回報 `UI_CHANGED`。
- 提供 timeout、合理間隔、有限重試、結構化日誌。
- 出現登入／挑戰／流量限制時立即停止，不採取反偵測措施。

優先 API 設計：

```python
async def search_items(keyword: str, server_id: int = 529) -> SearchResult:
    ...
```

`SearchResult` 至少含 `keyword`、`server_id`、`fetched_at`、`items`、`reported_count`、`pagination_status`、`source_status` 和 `errors`。

**不要把「保留 Cookie」寫成「永久免驗證」：Session 到期或網站要求重新驗證時必須通知真人。**

## 4. 回應解析與資料驗證

在 `models.py`、`parser.py` 實作：

- 對 `dt` 非陣列、`dt2` 缺失、資料型別錯誤採明確處理。
- 保留來源欄位及未知欄位以利後續 schema 變更。
- 商品價格須為大於零的整數；異常資料隔離，不能污染行情。
- `itemCNT` 應為非負數，零數量需標記為無效掛單或待確認。
- 時間一律使用 timezone-aware UTC，呈現時可轉 Asia/Taipei。
- `SSI2` 保留為 opaque value，先不要以它單獨當唯一 ID。
- `token`、驗證欄位不得被寫入一般日誌或資料表。

商品規格指紋應至少包含：

`itemName + itemRefining + ItemGradeLevel + DefaultSlotCount + slot_1..slot_4 + RandomOpt1..RandomOpt5`

建立規範化 canonical JSON 再 SHA-256；原始商品名稱應保留原樣供顯示，避免不當合併不同名稱。規格不完整時需標記 `SPEC_INCOMPLETE`。

## 5. 分頁探索與完整性證明

在 `paginator.py` 以可替換策略實作，不預設步長：

1. 優先用正常網頁「下一頁」操作觀察 `row_start`。
2. 記錄第一頁、第二頁、最後一頁的筆數和回應。
3. 驗證 `dt2[0].count` 是否真為總筆數。
4. 嚴格區分 `COMPLETE`、`PARTIAL`、`PAGINATION_UNVERIFIED`、`FAILED`。
5. 如果掛單在掃描過程變動，允許重複或漏列的可能性，不能宣稱原子快照。
6. 分頁結果需要跨頁去重與數量合理性檢查，但不應以模糊 ID 去重而漏掉不同賣家。
7. 記錄每個關鍵字的 `reported_count`、`fetched_count`、`unique_count`、`page_count`。

離線使用可配置的 `MockPaginator` 測試：總筆數 0、1、頁面大小整數倍、非整數倍、重複頁、空頁、超時與中途資料異動。

未有現場操作資料時，不要聲稱分頁可直接運作。

## 6. 商品索引與搜尋排程

`catalog.py` 載入合法來源的 CSV 商品名稱（必須提供 CSV 格式、匯入命令、測試資料）。可從正常搜尋回應新發現商品，但不能把這當成完整清單。針對外部商品資料來源須先查明授權與名稱對照。

`search_planner.py`：

- 支援 `P0` 高價品、`P1` 一般品、`P2` 冷門品。
- 優先掃描可形成價格基準、有較高掛單數、異常價差值得關注的商品。
- 關鍵字去重與候選分組僅使用正常搜尋允許的方式。
- 當寬鬆關鍵字結果過大、分頁無法驗證時，不宣稱掃描完整；適度分成更具體的商品名稱。
- 具備掃描預算（時間、查詢數）、公平輪巡與斷點續跑。
- 紀錄 `known_catalog_coverage` 與 `query_result_completeness`，二者不可混同於 `server_wide_coverage`。
- 若官方條款不允許自動擷取，提供 CSV/手動匯入模式供離線監測分析，不再啟用網站掃描器。

預設排程**僅為可配置目標**：P0 每 5 分鐘、P1 每 15 分鐘、P2 每 60 分鐘。預設 `max_concurrent_requests=1`，不可在未核准及未量測前提高；檢測到 429、403、CAPTCHA、異常大量失敗時立即停止或退避。使用者必須顯式啟用 live polling。

## 7. SQLite Schema

至少建立：

1. `item_catalog`：已知商品、名稱、類別、來源、優先級、發現與更新時間。
2. `search_keywords`：查詢詞、上次成功時間、最後狀態、目標頻率。
3. `scan_runs`：開始／結束、狀態、嘗試／成功查詢數、分頁完整性。
4. `listings`：當前已知掛單、商品規格、賣家、價格、數量、候選識別值、first_seen/last_seen。
5. `listing_snapshots`：逐次掛單觀測，指向 scan run；保存價格與數量。
6. `market_baselines`：同規格參考行情、樣本數、樣本類型、計算時間、可信度。
7. `price_alerts`：警報類型、去重鍵、通知渠道與發送結果。

需求：SQLAlchemy models、資料庫初始化／migration、Unique constraints、Index、foreign keys、WAL、transaction rollback、批次 upsert。SQLite 檔案及敏感 Profile 不得提交 Git。

注意：`storeName` + 商品規格不一定能唯一辨識實際攤位，不能用此假設將真實不同掛單合併。對缺少可靠 ID 的去重策略記錄信心與限制。

## 8. 行情基準 Baseline Engine

**重點：不要以同一個低價掛單或重複時間快照作為獨立行情樣本。**

優先順序：

1. 已確認合法取得的近期同規格成交價（若沒有則標示來源缺失）。
2. 同規格不同賣家的有效掛單價格。
3. 有時間衰減及異常值防護的歷史掛單。

採用加權或穩健中位數；記錄 `sample_count`、`distinct_sellers`、`sample_age`、`dispersion`、`source_type` 與 `confidence`。對檢測對象使用 leave-one-out 基準，禁止用被檢測掛單本身建立參考價。

初始可信度規則（可配置）：

- `HIGH`：至少 5 個足夠新鮮、同規格且相互獨立的有效參考；或品質相當的可靠成交樣本。
- `MEDIUM`：至少 3 個有效獨立參考且離散合理。
- `LOW`：1–2 個參考。
- `INSUFFICIENT`：無可靠參考或欄位不完整。

不以固定樣本數假裝各物品行情都準確；相關門檻必須可配置並在測試中驗證。

## 9. 少一個零與異常低價偵測

定義 `ratio = listing_price / reference_price`，僅在兩者都正數、商品規格相同且基準可用時運算。

| Ratio | Classification | Priority |
|---|---|---|
| 0.07 ≤ ratio ≤ 0.13 | POSSIBLE_MISSING_ZERO | CRITICAL (需足夠 confidence) |
| 0 < ratio < 0.07 | EXTREME_UNDERPRICE | HIGH/CRITICAL 依 confidence |
| 0.13 < ratio ≤ 0.30 | SIGNIFICANT_UNDERPRICE | HIGH |
| 0.30 < ratio ≤ 0.60 | DISCOUNT_WATCH | LOW |
| ratio > 0.60 | NORMAL | NONE |

另外計算 `tenfold_ratio = 10 * listing_price / reference_price`；當其落在 0.85–1.15 時標記 `MISSING_ZERO_MATCH`。不得據此斷言賣家一定輸入錯誤。

必須輸出：`anomaly_type`、`listing_price`、`reference_price`、`ratio`、`discount_pct`、`baseline_confidence`、`sample_count`、`observed_at`、`reason`。

有以下情況時**不發高信心價格錯誤通知**：

- 參考數據不足或過期。
- 規格、卡片或附魔不完整且可能影響行情。
- 同一家商店重複掛單被誤計為多個獨立參考。
- 官方回應沒有通過解析驗證。

## 10. 掛單追蹤、去重與通知

`listing_tracker.py`：採保守候選掛單指紋，組合 server、store、item_spec、price、quantity 及（若穩定已驗證）SSI2；價格變動視為新事件可再通知。相同事件不得每輪重送，但新的不同商店掛單應能分開通知。記錄去重鍵算法與風險。

`notifier.py`：

- Discord Webhook 與 Telegram Bot 二擇一或兩者並用。
- 憑證僅 `.env`，提供 `.env.example`；任何憑證都禁止印出或 commit。
- 通知失敗進入待重試佇列，帶 idempotency key，有限重試並記錄狀態。
- 提供 `--dry-run` 不發送真實訊息。
- 只連結官方查詢頁及使用者可正常開啟的來源，不臆造直接定位／購買 URL。

示範（必須清楚標記 DEMO，避免當成真實行情）：

```text
🚨 ROZ Market Sniper｜疑似價格標錯
伺服器：西格倫
商品：+9 銀月魔女靴
商店：Example Shop
新掛單：1,000,000 Z
同規格參考行情：10,000,000 Z
價格比例：10.0%
行情可信度：HIGH
參考樣本數：5
狀態：POSSIBLE_MISSING_ZERO
掃描時間：<台灣時間>
網站：https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch
```

## 11. 排程、掃描狀態和安全停機

`scheduler.py`：APScheduler 或同等可靠排程；掃描互斥鎖避免重疊執行。儲存上一輪狀態與中斷進度，可手動中止。

掃描狀態至少：`COMPLETE`、`PARTIAL`、`FAILED`、`AUTH_REQUIRED`、`CHALLENGE_REQUIRED`、`RATE_LIMITED`、`PAGINATION_UNVERIFIED`、`SOURCE_NOT_PERMITTED`。

指標：`keywords_attempted`、`keywords_succeeded`、`pages_fetched`、`listings_parsed`、`unique_listings`、`alerts_created`、`alerts_sent`、`scan_duration`、`catalog_coverage`。

遇到 403/429、CAPTCHA 重現、網站明確拒絕或條款限制時，停止 live polling，記錄原因並提醒人工介入。不得以密集重試、輪換 IP 或 Token 操作繞過。

## 12. CLI 和可執行命令

實作以下 CLI（名稱可調整，但 README 必須提供一鍵執行例子）：

```bash
python main.py init-db
python main.py import-catalog data/items.csv
python main.py verify-browser
python main.py scan --keyword "紅辣椒蝦湯" --once
python main.py scan --tier P0 --once
python main.py monitor --config config.yaml
python main.py analyze --from-fixture tests/fixtures/shop_response.json
python main.py alerts --limit 20
python main.py status
python main.py test-notifier --dry-run
```

`scan`/`monitor` 預設需要使用者明確設定 `enable_live_scanning: true`，驗證未完成時不能假裝抓取成功。`analyze --from-fixture` 全離線執行。

`config.example.yaml` 至少包含：

```yaml
server_id: 529
search:
  default_store_type: 2
  sort_by: itemPrice
  requested_tier: P0
browser:
  headless: false
  profile_dir: browser_profile
scheduler:
  p0_interval_minutes: 5
  p1_interval_minutes: 15
  p2_interval_minutes: 60
  max_concurrent_requests: 1
  request_timeout_seconds: 30
  retry_limit: 2
  enable_live_scanning: false
baseline:
  min_high_confidence_samples: 5
  min_medium_confidence_samples: 3
  max_age_hours: 72
alerts:
  missing_zero_min_ratio: 0.07
  missing_zero_max_ratio: 0.13
  discord_enabled: false
  telegram_enabled: false
```

README 包含 Windows PowerShell：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m playwright install chromium
python main.py init-db
python main.py analyze --from-fixture tests/fixtures/shop_response.json
python -m pytest -q
```

若環境沒有 Python 3.12，請指出適用替代版本及依賴相容性，不可聲稱上述命令已成功。

## 13. 必備測試與驗收

### 13.1 Parser

- 正常回應解析兩筆資料，價錢均為 2000，數量分別 1600/700。
- `dt2[0].count=2` 原樣保留但不強制視為完整總筆數。
- 缺失欄位、異常型別、空 `dt`、負數價錢、未知欄位處理。
- 不記錄 opaque token 與 Cookie。

### 13.2 Catalog & Pagination

- 重複商品名稱去重。
- 已知目錄覆蓋率計算。
- 假分頁的 0 / 1 / N 筆及最後一頁。
- 同一商品跨不同搜尋關鍵字去重。
- 未驗證分頁時不能標記 `COMPLETE`。

### 13.3 Baseline

- 同規格比較。
- 不同精煉、插卡、附魔分組。
- 同一商店或重複快照不能灌高獨立樣本數。
- leave-one-out 防止低價污染基準。
- 無參考行情回 `INSUFFICIENT`。

### 13.4 Anomaly

- 10,000,000 → 1,000,000：`POSSIBLE_MISSING_ZERO`。
- 10,000,000 → 900,000：同上。
- 10,000,000 → 5,000,000：`DISCOUNT_WATCH`。
- 10,000,000 → 9,500,000：`NORMAL`。
- 0 或負價：無效，不拋除零錯誤。
- 無可靠行情：不得高信心通知。
- 同一事件只發送一次，新商店的新掛單仍可通知。

### 13.5 Scheduler & Notifier

- 定時掃描無重疊。
- 遇到驗證失效停止。
- 遇到 403/429 停止或按站方規則退避。
- Mock Discord/Telegram 成功、失敗、重試、dry-run。
- 通知中不得含憑證。

至少執行：

```bash
python -m pytest -q
python -m ruff check .
python main.py analyze --from-fixture tests/fixtures/shop_response.json
```

若環境允許，可以額外驗證安裝與啟動；沒有實際帳號與人工驗證時不要宣稱 LIVE E2E 已完成。

## 14. 分階段實作里程碑

### Milestone A — 可離線運行

- 完整 repo / models / parser / SQLite / fixture / detector / CLI / tests。
- 所有核心功能可以不登入網站測試。

### Milestone B — 正常 UI 驅動

- Playwright Persistent Context。
- 正常手動驗證並登入。
- 可在頁面輸入關鍵字、抓取正常結果並解析。
- 有明確的 `AUTH_REQUIRED` / `CHALLENGE_REQUIRED`。

### Milestone C — 分頁與覆蓋率

- 用真實 UI 證實第二頁的 `row_start` 行為及結果總數語意。
- 匯入商品索引，建立 P0 / P1 / P2 輪巡。
- 提供覆蓋率報表，清楚區分已知商品覆蓋率與真正全市場覆蓋率。

### Milestone D — Live Monitoring

- 僅在網站允許且使用者明確啟用時開始週期掃描。
- 監控異常、去重、發通知、斷點續跑。
- 正確處理限流、驗證過期與來源不可用。

若 B/C/D 因網站存取受限無法完成，保留可用的 A、標示 blocked，寫下具體下一步驗證步驟，絕不聲稱 live 已成功。

## 15. 必須輸出的最終報告

Codex 完成後請輸出：

1. 實際建立／修改的檔案清單。
2. 執行過的安裝、測試、lint、CLI 命令及摘要輸出。
3. 測試通過數、失敗數；禁止編造。
4. API 行為驗證表（`LIVE_VERIFIED` / `FIXTURE_VERIFIED` / `UNVERIFIED`）。
5. 已知商品目錄覆蓋率與搜尋結果完整性；未確認時輸出 `UNKNOWN`，不可報 100%。
6. 完整啟動方式（Windows PowerShell）。
7. 登入／驗證需人工執行的精確步驟。
8. Discord／Telegram 設定步驟（不洩漏 Token）。
9. 待使用者提供的資料及目前 blocker。
10. 是否達到 Milestone A/B/C/D，每階段標記 PASS/PARTIAL/BLOCKED。

## 16. 最終執行指令

**現在開始直接工作。**

優先完成 Milestone A 的可執行程式和測試，接著實作 Milestone B/C 的正常網站操作接口。若環境具備合法存取及真人可配合驗證，再實測；否則用 fixture 與 mock 補足測試，不要等待、不要假裝網站成功。完成後提供清楚的交付狀態與下一步操作方式。
