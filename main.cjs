const { app, BrowserWindow, ipcMain, Notification, safeStorage, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { fromVisibleRows, analyze, listingKey } = require("./market.cjs");
const { MarketStore } = require("./store.cjs");
const { parseCsv } = require("./catalog.cjs");
const { validWebhook, sendDiscord } = require("./discord.cjs");
const { captureShopResponse, captureShopLocation, enrichVisibleRows, matchesVisible } = require("./capture.cjs");
const { collectPages } = require("./paginator.cjs");
const { navigationCommand } = require("./shop_location.cjs");

const shopUrl = "https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch";
const keywordDelayMs = 3000;
let scanIntervalMs = 10 * 60 * 1000;
let appWindow;
let shopWindow;
let scanTimer;
let scanInProgress = false;
let scanGeneration = 0;
let pausedScan = null;
let watchedKeywords = [];
let includeHotKeywords = false;
let thresholdRatio = 0.15;
let includeCatalog = false;
let marketStore;
let discordWebhook = null;
let activeProgress = null;
let deliveryInProgress = false;
let deliveryTimer;

function logEvent(code, details = {}) {
  if (!marketStore) return;
  const line = JSON.stringify({ at: new Date().toISOString(), code, ...details });
  try { fs.appendFileSync(path.join(app.getPath("userData"), "market.log"), `${line}\n`); }
  catch { sendStatus("無法寫入掃描 Log，請檢查資料夾權限。", "error"); }
}

function webhookPath() {
  return path.join(app.getPath("userData"), "discord-webhook.enc");
}

function checkpointPath() {
  return path.join(app.getPath("userData"), "scan-checkpoint.json");
}

function saveCheckpoint(progress) {
  fs.writeFileSync(checkpointPath(), JSON.stringify(progress));
}

function clearCheckpoint() {
  fs.rmSync(checkpointPath(), { force: true });
}

function loadCheckpoint() {
  try {
    const value = JSON.parse(fs.readFileSync(checkpointPath(), "utf8"));
    return Array.isArray(value.keywords) && Array.isArray(value.listings) &&
      Number.isInteger(value.nextIndex) && value.nextIndex >= 0 &&
      value.nextIndex < value.keywords.length && Number.isInteger(value.runId)
      ? { ...value, catalogDue: value.catalogDue ?? [], pageStatuses: value.pageStatuses ?? [] } : null;
  } catch { return null; }
}

function loadWebhook() {
  if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(webhookPath())) return null;
  try {
    const value = safeStorage.decryptString(fs.readFileSync(webhookPath()));
    return validWebhook(value) ? value : null;
  } catch { return null; }
}

async function deliverPendingAlerts() {
  if (!discordWebhook || deliveryInProgress) return;
  deliveryInProgress = true;
  try {
  for (const alert of marketStore.pendingAlerts()) {
    try {
      await sendDiscord(discordWebhook, alert);
      marketStore.markDelivery(alert.key, "sent");
      logEvent("DISCORD_SENT", { alertKey: alert.key });
    } catch (error) {
      const rateLimited = error.status === 429;
      const permanent = error.status >= 400 && error.status < 500 && !rateLimited;
      const delay = rateLimited ? error.retryAfterMs :
        Math.min(60000 * 2 ** alert.attempts, 3600000);
      const status = permanent || (!rateLimited && alert.attempts + 1 >= 3) ? "failed" : "pending";
      marketStore.markDelivery(alert.key, status,
        rateLimited ? "HTTP_429" : error.status ? `HTTP_${error.status}` : "DELIVERY_FAILED",
        status === "pending" ? new Date(Date.now() + delay).toISOString() : null, !rateLimited);
      logEvent("DISCORD_FAILED", { alertKey: alert.key });
      if (rateLimited) break;
    }
  }
  } finally { deliveryInProgress = false; }
}

function sendStatus(message, state = "info") {
  appWindow?.webContents.send("scan-status", { message, state });
}

function createAppWindow() {
  appWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  appWindow.loadFile("index.html");
  appWindow.webContents.once("did-finish-load", () => {
    appWindow.webContents.send("market-status", marketStore.status());
    if (pausedScan) {
      appWindow.webContents.send("scan-state", "paused");
      sendStatus("找到上次中斷的掃描。請先在查詢頁完成驗證，再按「驗證完成，繼續」。");
    }
  });
}

function openShopWindow() {
  if (shopWindow && !shopWindow.isDestroyed()) {
    shopWindow.focus();
    return;
  }

  shopWindow = new BrowserWindow({
    width: 1240,
    height: 900,
    title: "ROZ 露天商店查詢 - 請在此登入",
    webPreferences: {
      partition: "persist:gnjoy-shop-search",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  shopWindow.loadURL(shopUrl);
  shopWindow.on("closed", () => {
    shopWindow = null;
    stopScanning();
    sendStatus("查詢頁已關閉，自動掃描已停止。");
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShopReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!shopWindow || shopWindow.isDestroyed()) {
      throw new Error("查詢頁已關閉。");
    }
    const ready = await shopWindow.webContents.executeJavaScript(
      "document.readyState === 'complete' && !!document.querySelector('#txb_KeyWord')"
    );
    if (ready) return;
    await wait(500);
  }
  throw new Error("查詢頁載入逾時，請確認網路連線後重試。");
}

async function getScanKeywords() {
  let hotKeywords = [];
  if (includeHotKeywords) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      hotKeywords = await shopWindow.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('#topKeywords .topKeyword'), item => item.textContent.trim()).filter(Boolean)"
      );
      if (hotKeywords.length) break;
      await wait(500);
    }
    if (!hotKeywords.length) {
      throw new Error("查詢頁尚未載入熱門關鍵字，請確認網站正常顯示後重試。");
    }
  }

  const allKeywords = [...watchedKeywords];
  let catalogDue = [];
  if (includeCatalog) {
    const slots = Math.max(0, 20 - new Set(allKeywords).size);
    if (slots) {
      catalogDue = marketStore.dueCatalog(slots).map((item) => item.name);
      allKeywords.push(...catalogDue);
    }
  }
  allKeywords.push(...hotKeywords);
  const uniqueKeywords = [...new Set(allKeywords)];
  if (!uniqueKeywords.length && !includeCatalog) throw new Error("請輸入關鍵字或匯入商品索引。");
  const maxKeywords = 20;
  return {
    keywords: uniqueKeywords.slice(0, maxKeywords),
    wasCapped: uniqueKeywords.length > maxKeywords,
    hotKeywordCount: hotKeywords.length,
    catalogDue
  };
}

function toObservation(row) {
  return fromVisibleRows([row], row.keyword).map((item) => ({
    ...item, specification: row.specification ?? item.specification,
    specComplete: row.specComplete === true, source: row.source ?? item.source,
    ssi: row.ssi ?? null, location: row.location ?? null
  }));
}

async function runOneKeyword(keyword, generation, previous = [], history = []) {
  const capture = await captureShopResponse(shopWindow.webContents, keyword);
  if (!capture) throw new Error("無法驗證本次查詢的回應，已停止掃描。");
  try {
  capture.arm();
  const result = await shopWindow.webContents.executeJavaScript(
    `(() => {
      const loginButton = document.querySelector('#a_searchBtn');
      if (!loginButton || loginButton.textContent.includes('請先登入')) {
        return { error: '請先在查詢頁登入，並完成網站要求的驗證。' };
      }

      const server = document.querySelector('#div_svr');
      const selectedServer = server?.getAttribute('_val');
      if (!selectedServer || selectedServer === '0') {
        const option = document.querySelector('.selectSrv li[value="529"]');
        if (!server || !option) return { error: '找不到伺服器選項，請確認查詢頁正常載入。' };
        server.click();
        option.click();
      }

      const input = document.querySelector('#txb_KeyWord');
      const body = document.querySelector('#_tbody');
      const searchButton = document.querySelector('#searchBtn');
      if (!input || !body || !searchButton) return { error: '找不到查詢欄位或結果區。' };
      window.__shopResultChanged = false;
      window.__shopResultObserver?.disconnect();
      window.__shopResultObserver = new MutationObserver(() => { window.__shopResultChanged = true; });
      window.__shopResultObserver.observe(body, { childList: true, subtree: true, characterData: true });
      const noResults = document.querySelector('#PoringCry1');
      if (noResults) window.__shopResultObserver.observe(noResults, { attributes: true, childList: true, subtree: true });
      input.value = ${JSON.stringify(keyword)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      searchButton.click();
      return { started: true };
    })()`
  );
  if (result.error) throw new Error(result.error);

  let lastState = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(500);
    if (generation !== scanGeneration) return [];
    const captured = capture.peek();
    if (captured.response?.rateLimited) throw new Error("網站限制查詢（HTTP 403/429），掃描已停止。");
    if (captured.status === "ambiguous" || captured.status === "invalid") {
      throw new Error("查詢回應無法可靠配對，已停止掃描。");
    }
    const state = await shopWindow.webContents.executeJavaScript(`(() => {
      const message = document.querySelector('.swal2-html-container, .swal2-content');
      const messageText = message?.textContent?.trim() || '';
      const rows = Array.from(document.querySelectorAll('#_tbody tr'));
      const changed = window.__shopResultChanged === true;
      const loading = rows.some(row => row.textContent.includes('請稍候'));
      const noResultsElement = document.querySelector('#PoringCry1');
      const noResults = !!noResultsElement && noResultsElement.offsetParent !== null;
      const output = rows
        .filter(row => row.querySelectorAll('td').length >= 6)
        .map((row, rowIndex) => {
          const cells = Array.from(row.querySelectorAll('td')).map(cell => cell.textContent.trim());
          return {
            rowIndex,
            ssi: row.querySelector('.shopName')?.getAttribute('SSI') || null,
            shop: cells[0],
            itemName: cells[1],
            slots: cells[2],
            price: Number(cells[3].replace(/[^0-9]/g, '')),
            quantity: Number(cells[4].replace(/[^0-9]/g, '')),
            storeType: cells[5]
          };
        });
      return { changed, loading, noResults, output, messageText };
    })()`);
    lastState = state;

    if (state.messageText && /登入|驗證|圖形驗證|驗證碼/.test(state.messageText)) {
      throw new Error(`網站要求處理：${state.messageText}`);
    }
    if (state.changed && !state.loading &&
        (state.output.length > 0 || state.noResults || captured.response?.items?.length === 0) &&
        captured.status === "ready" && matchesVisible(state.output, captured.response)) {
      await shopWindow.webContents.executeJavaScript("window.__shopResultObserver?.disconnect()");
      const visible = state.output.map((listing) => ({ ...listing, keyword }));
      const page = await collectPages(async () => ({
        items: enrichVisibleRows(visible, captured.response),
        reportedCount: captured.response.reportedCount, hasNext: null
      }), { maxPages: 1 });
      capture.close();
      const provisional = analyze([...previous, ...page.items.flatMap(toObservation)], history)
        .filter((item) => item.sampleCount >= 3 && item.ratio <= thresholdRatio);
      const targetKeys = new Set(provisional.map(listingKey));
      for (const row of page.items) {
        if (generation !== scanGeneration) break;
        const [item] = toObservation(row);
        if (!item || !row.ssi || !targetKeys.has(listingKey(item))) continue;
        try {
          const request = { rowIndex: row.rowIndex, ssi: row.ssi, shop: row.shop,
            price: row.price, quantity: row.quantity };
          row.location = await captureShopLocation(shopWindow.webContents,
            { ...row, serverId: 529 }, () => shopWindow.webContents.executeJavaScript(`(() => {
              const target = ${JSON.stringify(request)};
              const tr = document.querySelectorAll('#_tbody tr')[target.rowIndex];
              const shop = tr?.querySelector('.shopName');
              const cells = tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : [];
              if (!shop || shop.getAttribute('SSI') !== target.ssi ||
                  cells[0] !== target.shop ||
                  Number(cells[3].replace(/[^0-9]/g, '')) !== target.price ||
                  Number(cells[4].replace(/[^0-9]/g, '')) !== target.quantity) return false;
              shop.click();
              return true;
            })()`));
          await shopWindow.webContents.executeJavaScript(
            "document.querySelector('.popup__itemInfo .close')?.click()");
        } catch (error) { logEvent("SHOP_LOCATION_FAILED", { reason: error.message }); }
      }
      return { rows: page.items, status: page.status, pageCount: page.pageCount,
        reportedCount: page.reportedCount };
    }
  }
  const captured = capture.peek();
  logEvent("SEARCH_TIMEOUT", { searchRequests: captured.searchRequests,
    matchedRequests: captured.matchedRequests,
    unreadableRequests: captured.unreadableRequests,
    captureStatus: captured.status, domChanged: lastState?.changed ?? false,
    visibleRows: lastState?.output?.length ?? 0 });
  const reason = !captured.searchRequests ? "頁面未送出搜尋請求，請檢查登入與圖形驗證" :
    captured.unreadableRequests ? "無法讀取搜尋請求以核對關鍵字" :
    !captured.matchedRequests ? "搜尋請求的關鍵字與本輪不符" :
    captured.status === "ready" && !matchesVisible(lastState?.output ?? [], captured.response)
      ? "搜尋回應與畫面資料不一致" :
    !lastState?.changed ? "搜尋結果畫面未更新" : "網站尚未完成搜尋";
  throw new Error(`「${keyword}」查詢逾時：${reason}。請在查詢頁確認後再繼續。`);
  } finally {
    capture.close();
  }
}

async function scan(resumeState = null) {
  if (scanInProgress) return;
  if (!shopWindow || shopWindow.isDestroyed()) {
    sendStatus("請先開啟查詢頁並登入。", "error");
    stopScanning();
    return;
  }

  scanInProgress = true;
  const generation = scanGeneration;
  sendStatus("掃描中…");
  let progress = resumeState;
  try {
    await waitForShopReady();
    if (generation !== scanGeneration) return;
    if (!progress) {
      const { keywords, wasCapped, hotKeywordCount, catalogDue } = await getScanKeywords();
      progress = { keywords, wasCapped, hotKeywordCount, catalogDue,
        listings: [], pageStatuses: [], nextIndex: 0, runId: marketStore.startRun() };
    }
    activeProgress = progress;
    if (generation !== scanGeneration) return;
    const { keywords, wasCapped, hotKeywordCount, listings } = progress;
    const history = marketStore.historicalReferences();
    if (!keywords.length) {
      marketStore.finishRun(progress.runId, "PARTIAL", { paginationStatus: "PAGINATION_UNVERIFIED" });
      activeProgress = null;
      clearCheckpoint();
      sendStatus("目前沒有到期的商品索引關鍵字，等待下一輪。", "info");
      return;
    }
    sendStatus(`掃描中：${keywords.length} 個關鍵字${includeHotKeywords ? `（網站熱門詞 ${hotKeywordCount} 個）` : ""}…`);
    for (let index = progress.nextIndex; index < keywords.length; index += 1) {
      if (generation !== scanGeneration) return;
      if (index > 0 || resumeState) await wait(keywordDelayMs);
      if (generation !== scanGeneration) return;
      const page = await runOneKeyword(keywords[index], generation,
        listings.flatMap(toObservation), history);
      if (generation !== scanGeneration) return;
      listings.push(...page.rows);
      progress.pageStatuses.push(page.status);
      if (progress.catalogDue?.includes(keywords[index])) marketStore.markKeyword(keywords[index], true);
      progress.nextIndex = index + 1;
      saveCheckpoint(progress);
    }

    const observations = listings.flatMap(toObservation);
    const analyses = analyze(observations, history);
    const freshCandidates = marketStore.saveObservations(progress.runId, observations, analyses,
      { maxAlertRatio: thresholdRatio }).map((item) => ({
        ...item, navigation: navigationCommand(item.location)
      }));
    marketStore.finishRun(progress.runId, "PARTIAL", {
      attempted: keywords.length, succeeded: keywords.length, listings: observations.length,
      paginationStatus: progress.pageStatuses.every((status) => status === "COMPLETE")
        ? "COMPLETE" : "PAGINATION_UNVERIFIED"
    });
    activeProgress = null;
    clearCheckpoint();
    await deliverPendingAlerts();
    for (const candidate of freshCandidates) {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: "ROZ 發現疑似低價商品",
          body: `${candidate.itemName}：${candidate.price.toLocaleString()} Z（參考中位價 ${candidate.referencePrice.toLocaleString()} Z）`
        });
        notification.on("click", () => {
          if (appWindow && !appWindow.isDestroyed()) {
            appWindow.show();
            appWindow.focus();
          }
        });
        notification.show();
      }
    }
    if (freshCandidates.length && appWindow && !appWindow.isDestroyed()) {
      appWindow.show();
      appWindow.focus();
    }
    appWindow?.webContents.send("scan-results", {
      checkedAt: new Date().toISOString(),
      listingCount: listings.length,
      candidates: freshCandidates
    });
    appWindow?.webContents.send("market-status", marketStore.status());
    sendStatus(
      `掃描完成：查詢 ${keywords.length} 個關鍵字，查到 ${listings.length} 筆，新增 ${freshCandidates.length} 個低價候選。${wasCapped ? "關鍵字超過 20 個，已依序保留前 20 個。" : ""}下一次約 ${scanIntervalMs / 60000} 分鐘後。分頁尚未驗證。`,
      "success"
    );
  } catch (error) {
    if (generation !== scanGeneration) return;
    if (progress?.catalogDue?.includes(progress.keywords[progress.nextIndex])) {
      marketStore.markKeyword(progress.keywords[progress.nextIndex], false);
    }
    if (progress && /登入|驗證|驗證碼/.test(error.message)) {
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
      pausedScan = progress;
      saveCheckpoint(progress);
      const status = /查詢逾時/.test(error.message) ? "PARTIAL" :
        /請先登入/.test(error.message) ? "AUTH_REQUIRED" : "CHALLENGE_REQUIRED";
      marketStore.finishRun(progress.runId, status, {
        attempted: progress.nextIndex + 1, succeeded: progress.nextIndex,
        listings: progress.listings.length
      });
      logEvent(status, { runId: progress.runId });
      appWindow?.webContents.send("scan-state", "paused");
      shopWindow?.focus();
      sendStatus(`${error.message} 請在查詢頁完成處理，再按「驗證完成，繼續」。`, "error");
      return;
    }
    const status = /HTTP 403\/429/.test(error.message) ? "RATE_LIMITED" : "FAILED";
    if (progress) marketStore.finishRun(progress.runId, status, {
      attempted: progress.nextIndex + 1, succeeded: progress.nextIndex,
      listings: progress.listings.length
    }, "SCAN_FAILED");
    activeProgress = null;
    stopScanning();
    logEvent(status, { runId: progress?.runId ?? null });
    sendStatus(`${error.message} 自動掃描已停止。`, "error");
  } finally {
    scanInProgress = false;
  }
}

function stopScanning() {
  scanGeneration += 1;
  if (activeProgress) {
    marketStore?.finishRun(activeProgress.runId, "PARTIAL", {
      attempted: activeProgress.nextIndex, succeeded: activeProgress.nextIndex,
      listings: activeProgress.listings.length
    }, "USER_STOPPED");
  }
  activeProgress = null;
  pausedScan = null;
  clearCheckpoint();
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  appWindow?.webContents.send("scan-state", "stopped");
}

ipcMain.handle("open-shop", () => {
  openShopWindow();
});

ipcMain.handle("start-scanning", async (_event, config) => {
  if (scanInProgress) throw new Error("上一輪掃描尚未結束，請稍候再開始。");
  if (pausedScan) stopScanning();
  const keywords = Array.isArray(config?.keywords)
    ? [...new Set(config.keywords.map((value) => String(value).trim()).filter(Boolean))]
    : [];
  const shouldIncludeHotKeywords = config?.includeHotKeywords === true;
  const shouldIncludeCatalog = config?.includeCatalog === true;
  const intervalMinutes = Number(config?.intervalMinutes ?? 10);
  const ratio = Number(config?.ratio);
  if (!keywords.length && !shouldIncludeHotKeywords && !shouldIncludeCatalog) throw new Error("請輸入追蹤關鍵字或選擇其他搜尋來源。");
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 120) {
    throw new Error("掃描間隔需介於 5 到 120 分鐘。");
  }
  if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 0.5) {
    throw new Error("低價門檻需介於 1% 到 50%。");
  }
  watchedKeywords = keywords;
  includeHotKeywords = shouldIncludeHotKeywords;
  includeCatalog = shouldIncludeCatalog;
  scanIntervalMs = intervalMinutes * 60 * 1000;
  thresholdRatio = ratio;
  pausedScan = null;
  if (!shopWindow || shopWindow.isDestroyed()) openShopWindow();
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(scan, scanIntervalMs);
  appWindow?.webContents.send("scan-state", "running");
  await scan();
});

ipcMain.handle("resume-scanning", async () => {
  if (scanInProgress) throw new Error("上一輪掃描尚未結束，請稍候再繼續。");
  if (!pausedScan) throw new Error("目前沒有可繼續的掃描。");
  const progress = pausedScan;
  pausedScan = null;
  if (!shopWindow || shopWindow.isDestroyed()) {
    pausedScan = progress;
    throw new Error("查詢頁已關閉，請先開啟並完成驗證。");
  }
  scanTimer = setInterval(scan, scanIntervalMs);
  appWindow?.webContents.send("scan-state", "running");
  await scan(progress);
});

ipcMain.handle("stop-scanning", () => stopScanning());
ipcMain.handle("show-shop", () => shopWindow?.focus());
ipcMain.handle("import-catalog", (_event, csv) => {
  if (typeof csv !== "string" || csv.length > 1024 * 1024) throw new Error("CSV 不可超過 1 MB。");
  const count = marketStore.importCatalog(parseCsv(csv));
  appWindow?.webContents.send("market-status", marketStore.status());
  return count;
});
ipcMain.handle("market-status", () => marketStore.status());
ipcMain.handle("set-discord", (_event, url) => {
  if (url === "") {
    discordWebhook = null;
    fs.rmSync(webhookPath(), { force: true });
    return false;
  }
  if (typeof url !== "string" || !validWebhook(url)) throw new Error("Discord Webhook 網址無效。");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系統無法安全加密 Webhook，設定未儲存。");
  fs.writeFileSync(webhookPath(), safeStorage.encryptString(url));
  discordWebhook = url;
  return true;
});
ipcMain.handle("discord-status", () => Boolean(discordWebhook));
ipcMain.handle("copy-navigation", (_event, command) => {
  if (typeof command !== "string" ||
      !/^\/navi [A-Za-z][A-Za-z0-9_]* [1-9]\d*\/[1-9]\d*$/.test(command)) {
    throw new Error("導航指令無效");
  }
  clipboard.writeText(command);
});

app.whenReady().then(() => {
  marketStore = new MarketStore(path.join(app.getPath("userData"), "market.sqlite"));
  discordWebhook = loadWebhook();
  pausedScan = loadCheckpoint();
  createAppWindow();
  deliveryTimer = setInterval(() => deliverPendingAlerts().catch(() =>
    logEvent("DELIVERY_LOOP_FAILED")), 60000);
});
app.on("window-all-closed", () => {
  stopScanning();
  if (deliveryTimer) clearInterval(deliveryTimer);
  marketStore?.close();
  if (process.platform !== "darwin") app.quit();
});
