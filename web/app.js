const $ = (selector) => document.querySelector(selector);
let selectedId = null;
let listingCursor = null;
let cursor = null;
let query = "";

async function api(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "查詢失敗");
  return data;
}

function table(headings, rows) {
  const element = document.createElement("table");
  const header = element.createTHead().insertRow();
  headings.forEach((heading) => { header.insertCell().textContent = heading; });
  const body = element.createTBody();
  rows.forEach((values) => {
    const row = body.insertRow();
    values.forEach((value) => {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
    });
  });
  return element;
}

function show(container, node) { container.replaceChildren(node); }
function button(label, action) {
  const element = document.createElement("button");
  element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

async function overview() {
  const [summary, sources, sync, coverage] = await Promise.all([
    api("/api/market/summary"), api("/api/sources"),
    api("/api/sync/status"), api("/api/coverage")]);
  show($("#summary"), table(["項目", "狀態"], [
    ["Server ID", summary.serverId], ["已知商品", summary.knownItems],
    ["已存掛單", summary.listings], ["待送通知", summary.pendingAlerts],
    ["待確認候選", summary.watchlist],
    ["完整規格掛單", summary.completeSpecifications],
    ["最近觀測掛單", summary.recentObservations],
    ["完整頁組暫存掛單", summary.activeObservations],
    ["最近官方觀測", summary.lastOfficialObservation],
    ["最近同步", summary.lastSync], ["同步狀態", sync.state],
    ["已知索引掃描", String(coverage.scanned ?? 0) + "/" + String(coverage.known ?? 0)],
    ["官方查詢進度", sync.officialProgress ?
      String(sync.officialProgress.completedKeywords) + "/" +
      String(sync.officialProgress.totalKeywords) : "—"]
  ]));
  show($("#sources"), table(["來源", "類型", "授權", "啟用", "最後成功", "最後錯誤"],
    sources.items.map((source) => [source.name, source.sourceType,
      source.authorizationStatus, source.enabled ? "是" : "否",
      source.lastSuccessAt, source.lastError])));
}

async function search(reset = false) {
  if (reset) { query = $("#query").value.trim(); cursor = null; $("#item-results").replaceChildren(); }
  const params = new URLSearchParams({ q: query, limit: "25", cursor: cursor ?? "0" });
  const data = await api("/api/items?" + params);
  const rows = data.items.map((item) => [item.itemName, item.lowestPrice,
    item.listingCount, item.specComplete ? "完整" : "規格不足",
    button("查看掛單與歷史", () => selectItem(item.id))]);
  const existing = reset ? [] : Array.from($("#item-results").children);
  $("#item-results").replaceChildren(...existing,
    table(["商品", "最低開價", "掛單數", "規格", "操作"], rows));
  cursor = data.nextCursor;
  $("#more-items").hidden = !cursor;
}

async function selectItem(id) {
  selectedId = id;
  listingCursor = null;
  await loadListings(true);
  await history();
}

async function loadListings(reset = false) {
  const data = await api("/api/items/" + selectedId + "/listings?cursor=" +
    (listingCursor ?? "0"));
  const existing = reset ? [] : Array.from($("#listing-results").children);
  $("#listing-results").replaceChildren(...existing,
    table(["商品", "規格", "商店", "價格", "數量", "觀測時間", "距今秒數", "最近完整頁觀測", "來源", "規格品質", "資料狀態", "座標"],
    data.items.map((item) => [item.itemName, item.specification ? JSON.stringify(item.specification) : "規格未記錄",
      item.shop, item.price, item.quantity,
      item.observedAt, item.ageSeconds, item.lastVerifiedAt, item.source,
      item.quality, item.state, item.navigation
        ? button(item.navigation, () => navigator.clipboard.writeText(item.navigation)) : "尚未驗證"])));
  listingCursor = data.nextCursor;
  $("#more-listings").hidden = !listingCursor;
}

async function history() {
  if (!selectedId) return;
  const data = await api("/api/items/" + selectedId + "/history?range=" + $("#history-range").value);
  const wrapper = document.createElement("div");
  wrapper.append(table(["目前最低開價", "獨立賣家", "參考中位價", "歷史最低觀測開價"], [[
    data.current.lowestAsk, data.current.independentSellers,
    data.baseline?.referenceMedian, data.historicalLowest
  ]]));
  wrapper.append(table(["日期", "最低掛單開價", "樣本數"],
    data.asks.map((row) => [row.day, row.lowestAsk, row.samples])));
  const sales = document.createElement("p");
  sales.textContent = data.sales.length ? "可信成交紀錄 " + data.sales.length + " 天" : "暫無可信成交紀錄";
  wrapper.append(sales, table(["成交日期", "最低成交價格", "樣本數"],
    data.sales.map((row) => [row.day, row.lowestSale, row.samples])));
  show($("#history-results"), wrapper);
}

async function alerts() {
  const data = await api("/api/alerts");
  const wrapper = document.createElement("div");
  wrapper.append(table(["警報 ID", "商品", "商店", "價格", "參考價", "低價比例", "信心", "二次確認", "座標", "Discord", "來源", "觀測時間", "建立時間", "更新時間"],
    data.items.map((alert) => [alert.key, alert.itemName, alert.shop, alert.price,
      alert.referencePrice, (alert.price / alert.referencePrice * 100).toFixed(1) + "%",
      alert.confidence, alert.verificationStatus, alert.locationStatus, alert.deliveryStatus,
      alert.source,
      alert.observedAt, alert.createdAt, alert.updatedAt])));
  const heading = document.createElement("h3");
  heading.textContent = "待確認候選";
  wrapper.append(heading, table(["商品", "商店", "價格", "參考價", "樣本", "來源", "原因"],
    data.watchlist.map((item) => [item.itemName, item.shop, item.price,
      item.referencePrice, item.sampleCount, item.sources ?? item.sourceId, item.reason])));
  show($("#alert-results"), wrapper);
}

async function run(action) {
  try { $("#message").textContent = ""; await action(); }
  catch (error) { $("#message").textContent = error.message; }
}

document.querySelectorAll("[data-page]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("main section").forEach((section) => { section.hidden = section.id !== tab.dataset.page; });
  if (tab.dataset.page === "overview") run(overview);
  if (tab.dataset.page === "alerts") run(alerts);
}));
$("#search").addEventListener("submit", (event) => { event.preventDefault(); run(() => search(true)); });
$("#more-items").addEventListener("click", () => run(() => search()));
$("#more-listings").addEventListener("click", () => run(() => loadListings()));
$("#history-range").addEventListener("change", () => run(history));
run(overview);
