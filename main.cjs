const { app, BrowserWindow, ipcMain, Notification, safeStorage, clipboard,
  dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { SERVER_ID, fromVisibleRows, analyze } = require("./market.cjs");
const { MarketStore } = require("./store.cjs");
const { parseCsv } = require("./catalog.cjs");
const { validWebhook, sendDiscord } = require("./discord.cjs");
const { scanKeywordPages, challengeVisible } = require("./shop_scanner.cjs");
const { navigationCommand } = require("./shop_location.cjs");
const { planKeywords } = require("./keyword_plan.cjs");
const { MarketRepository } = require("./market_repository.cjs");
const { createLocalServer } = require("./local_server.cjs");
const { AuthorizedFileAdapter } = require("./source_import.cjs");

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
let manualCursor = 0;
let marketStore;
let discordWebhook = null;
let activeProgress = null;
let deliveryInProgress = false;
let importInProgress = false;
let deliveryTimer;
let localServer;
let localUrl;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function logStartup(stage, error = null) {
  const message = `${new Date().toISOString()} ${stage}${error ? ` ${error.stack || error}` : ""}\n`;
  try { fs.appendFileSync(path.join(app.getPath("userData"), "startup.log"), message); }
  catch { process.stderr.write(message); }
}

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
  const temporary = `${checkpointPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(progress));
  fs.renameSync(temporary, checkpointPath());
}

function clearCheckpoint() {
  fs.rmSync(checkpointPath(), { force: true });
}

function loadCheckpoint() {
  try {
    const value = JSON.parse(fs.readFileSync(checkpointPath(), "utf8"));
    return Array.isArray(value.keywords) && Array.isArray(value.listings) &&
      Number.isInteger(value.nextIndex) && value.nextIndex >= 0 &&
      value.nextIndex <= value.keywords.length && Number.isInteger(value.runId)
      ? { ...value, phase: ["SCANNING", "SNAPSHOT_SAVED", "VERIFYING"]
        .includes(value.phase) ? value.phase : "SCANNING",
      catalogDue: value.catalogDue ?? [], pageStatuses: value.pageStatuses ?? [] } : null;
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
  if (!discordWebhook || deliveryInProgress || importInProgress) return;
  deliveryInProgress = true;
  try {
  for (const alert of marketStore.pendingAlerts()) {
    try {
      if (!marketStore.claimDelivery(alert.key)) continue;
      await sendDiscord(discordWebhook, alert);
      marketStore.markDelivery(alert.key, "sent", null, null, false);
      logEvent("DISCORD_SENT", { alertKey: alert.key });
    } catch (error) {
      const rateLimited = error.status === 429;
      const permanent = error.status >= 400 && error.status < 500 && !rateLimited;
      const delay = rateLimited ? error.retryAfterMs :
        Math.min(60000 * 2 ** alert.attempts, 3600000);
      const status = permanent || (!rateLimited && alert.attempts + 1 >= 3) ? "failed" : "pending";
      if (rateLimited) {
        marketStore.markRateLimited(alert.key, new Date(Date.now() + delay).toISOString());
      } else {
        marketStore.markDelivery(alert.key, status,
          error.status ? `HTTP_${error.status}` : "DELIVERY_FAILED",
          status === "pending" ? new Date(Date.now() + delay).toISOString() : null, false);
      }
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
  logStartup("CREATE_WINDOW");
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
  logStartup("LOAD_FILE_REQUESTED");
  appWindow.webContents.on("did-fail-load", (_event, code, description) =>
    logStartup("DID_FAIL_LOAD", `${code} ${description}`));
  appWindow.webContents.on("render-process-gone", (_event, details) =>
    logStartup("RENDER_PROCESS_GONE", details.reason));
  appWindow.once("ready-to-show", () => {
    logStartup("READY_TO_SHOW");
    appWindow.show();
    appWindow.focus();
  });
  appWindow.webContents.once("did-finish-load", () => {
    logStartup("DID_FINISH_LOAD");
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
    if (await challengeVisible(shopWindow.webContents)) {
      throw new Error("查詢頁要求圖形驗證，請由使用者完成。");
    }
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

  const catalog = includeCatalog ? marketStore.dueCatalog(20).map((item) => item.name) : [];
  const plan = planKeywords({ manual: watchedKeywords, catalog,
    hot: hotKeywords, cursor: manualCursor });
  if (!plan.keywords.length && !includeCatalog) throw new Error("請輸入關鍵字或匯入商品索引。");
  manualCursor = plan.nextCursor;
  return {
    keywords: plan.keywords,
    wasCapped: plan.wasCapped,
    hotKeywordCount: hotKeywords.length,
    catalogDue: plan.catalogDue
  };
}

function toObservation(row) {
  return fromVisibleRows([row], row.keyword).map((item) => ({
    ...item, specification: row.specification ?? item.specification,
    specificationJson: row.specificationJson ?? null,
    specComplete: row.specComplete === true, source: row.source ?? item.source,
    ssi: row.ssi ?? null, observationKey: row.observationKey ?? null,
    location: row.location ?? null
  }));
}

async function scan(resumeState = null) {
  if (scanInProgress || importInProgress) return;
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
    if (!progress) {
      progress = { keywords: [], planned: false, listings: [], pageStatuses: [],
        nextIndex: 0, phase: "SCANNING", catalogDue: [],
        requestStats: { searches: 0, requests: 0 },
        ratio: thresholdRatio, intervalMs: scanIntervalMs,
        config: { watchedKeywords, includeHotKeywords, includeCatalog },
        runId: marketStore.startRun() };
      saveCheckpoint(progress);
    }
    if (progress.config) {
      watchedKeywords = progress.config.watchedKeywords;
      includeHotKeywords = progress.config.includeHotKeywords;
      includeCatalog = progress.config.includeCatalog;
    }
    await waitForShopReady();
    if (generation !== scanGeneration) return;
    if (progress.planned === false) {
      const { keywords, wasCapped, hotKeywordCount, catalogDue } = await getScanKeywords();
      Object.assign(progress, { keywords, wasCapped, hotKeywordCount, catalogDue,
        planned: true });
      saveCheckpoint(progress);
    }
    activeProgress = progress;
    if (Number.isFinite(progress.ratio) && progress.ratio >= 0.01 && progress.ratio <= 0.5) {
      thresholdRatio = progress.ratio;
    }
    if (Number.isInteger(progress.intervalMs) && progress.intervalMs >= 300000 &&
        progress.intervalMs <= 7200000) scanIntervalMs = progress.intervalMs;
    progress.requestStats ??= { searches: 0, requests: 0 };
    const onRequest = () => {
      progress.requestStats.requests += 1;
      saveCheckpoint(progress);
      sendStatus(`掃描中：搜尋嘗試 ${progress.requestStats.searches} 次，官方查詢請求 ${progress.requestStats.requests} 次。`);
    };
    if (generation !== scanGeneration) return;
    const { keywords, wasCapped, hotKeywordCount, listings } = progress;
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
      marketStore.markSearchAttempt(progress.runId, keywords[index]);
      progress.requestStats.searches += 1;
      saveCheckpoint(progress);
      appWindow?.webContents.send("market-status", marketStore.status());
      const page = await scanKeywordPages(shopWindow.webContents, keywords[index], {
        isActive: () => generation === scanGeneration,
        runId: progress.runId, onRequest
      });
      if (generation !== scanGeneration) return;
      marketStore.recordKeywordPages(progress.runId, keywords[index], page);
      marketStore.saveObservations(progress.runId, page.items.flatMap(toObservation), [],
        { scannedKeywords: page.status === "COMPLETE" ? [keywords[index]] : [] });
      if (page.status === "COMPLETE") {
        marketStore.recordWatchlist?.(page.items.flatMap(toObservation),
          "gnjoy-ui", thresholdRatio);
      }
      listings.push(...page.items);
      progress.pageStatuses.push(page.status);
      if (progress.catalogDue?.includes(keywords[index])) {
        marketStore.markKeyword(keywords[index], page.status === "COMPLETE");
      }
      progress.nextIndex = index + 1;
      saveCheckpoint(progress);
    }

    const completed = new Set(keywords.filter((_, index) =>
      progress.pageStatuses[index] === "COMPLETE"));
    const observations = listings.flatMap(toObservation)
      .filter((item) => item.serverId === SERVER_ID);
    if (progress.phase === "SCANNING") {
      marketStore.saveObservations(progress.runId, observations, [],
        { scannedKeywords: [...completed] });
      progress.phase = "SNAPSHOT_SAVED";
      saveCheckpoint(progress);
    }
    const trusted = observations.filter((item) => completed.has(item.keyword));
    const analyses = analyze(trusted, marketStore.activeReferences(),
      marketStore.recentReferences());
    const candidates = marketStore.unseenCandidates(analyses, thresholdRatio);
    progress.phase = "VERIFYING";
    saveCheckpoint(progress);
    for (const keyword of new Set(candidates.map((item) => item.keyword))) {
      if (generation !== scanGeneration) return;
      await wait(keywordDelayMs);
      marketStore.markSearchAttempt(progress.runId, keyword);
      progress.requestStats.searches += 1;
      saveCheckpoint(progress);
      appWindow?.webContents.send("market-status", marketStore.status());
      const result = await scanKeywordPages(shopWindow.webContents, keyword, {
        isActive: () => generation === scanGeneration, runId: progress.runId, onRequest,
        targets: candidates.filter((item) => item.keyword === keyword)
      });
      if (result.status !== "COMPLETE") {
        for (const item of candidates.filter((entry) => entry.keyword === keyword)) {
          item._confirmed = false;
          item.location = null;
        }
      } else {
        for (const item of candidates.filter((entry) =>
          entry.keyword === keyword && entry._confirmed !== true)) {
          marketStore.markListingUnavailable(item);
        }
      }
    }
    const confirmed = analyses.filter((item) =>
      !candidates.includes(item) || item._confirmed === true);
    const freshCandidates = marketStore.saveObservations(progress.runId, [], confirmed,
      { maxAlertRatio: thresholdRatio }).map((item) => ({
        ...item, navigation: navigationCommand(item.location)
      }));
    marketStore.finishRun(progress.runId,
      completed.size === keywords.length ? "COMPLETE" : "PARTIAL", {
      attempted: keywords.length, succeeded: completed.size, listings: observations.length,
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
      `掃描完成：查詢 ${keywords.length} 個關鍵字，查到 ${listings.length} 筆，新增 ${freshCandidates.length} 個低價候選。搜尋嘗試 ${progress.requestStats.searches} 次，官方查詢請求 ${progress.requestStats.requests} 次。${wasCapped ? "關鍵字超過 20 個，已依序保留前 20 個。" : ""}下一次約 ${scanIntervalMs / 60000} 分鐘後。分頁尚未驗證。`,
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
      const status = /請先登入/.test(error.message) ? "AUTH_REQUIRED" : "CHALLENGE_REQUIRED";
      progress.pauseReason = status;
      saveCheckpoint(progress);
      marketStore.finishRun(progress.runId, status, {
        attempted: progress.nextIndex, succeeded: progress.pageStatuses
          .filter((value) => value === "COMPLETE").length,
        listings: progress.listings.length
      });
      appWindow?.webContents.send("market-status", marketStore.status());
      logEvent(status, { runId: progress.runId, ...progress.requestStats });
      appWindow?.webContents.send("scan-state", "paused");
      shopWindow?.focus();
      sendStatus(`${error.message} 請在查詢頁完成處理，再按「驗證完成，繼續」。搜尋嘗試 ${progress.requestStats?.searches ?? 0} 次，官方查詢請求 ${progress.requestStats?.requests ?? 0} 次。`, "error");
      return;
    }
    if (progress && ["SNAPSHOT_SAVED", "VERIFYING"].includes(progress.phase)) {
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
      pausedScan = progress;
      progress.pauseReason = "PARTIAL";
      saveCheckpoint(progress);
      marketStore.finishRun(progress.runId, "PARTIAL", {
        attempted: progress.nextIndex, succeeded: progress.pageStatuses
          .filter((status) => status === "COMPLETE").length,
        listings: progress.listings.length,
        paginationStatus: "PAGINATION_UNVERIFIED"
      }, "CANDIDATE_VERIFICATION_INTERRUPTED");
      appWindow?.webContents.send("market-status", marketStore.status());
      appWindow?.webContents.send("scan-state", "paused");
      sendStatus(`掛單快照已保存；候選確認中斷：${error.message}。請處理後按「驗證完成，繼續」。`, "error");
      return;
    }
    const status = /HTTP 403\/429/.test(error.message) ? "RATE_LIMITED" : "FAILED";
    if (progress) marketStore.finishRun(progress.runId, status, {
      attempted: progress.nextIndex + 1, succeeded: progress.nextIndex,
      listings: progress.listings.length
    }, "SCAN_FAILED");
    appWindow?.webContents.send("market-status", marketStore.status());
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
  if (importInProgress) throw new Error("行情匯入中，請稍後開始掃描。");
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
  if (importInProgress) throw new Error("行情匯入中，請稍後繼續掃描。");
  if (scanInProgress) throw new Error("上一輪掃描尚未結束，請稍候再繼續。");
  if (!pausedScan) throw new Error("目前沒有可繼續的掃描。");
  const progress = pausedScan;
  pausedScan = null;
  if (!shopWindow || shopWindow.isDestroyed()) {
    pausedScan = progress;
    throw new Error("查詢頁已關閉，請先開啟並完成驗證。");
  }
  scanTimer = setInterval(scan, progress.intervalMs ?? scanIntervalMs);
  appWindow?.webContents.send("scan-state", "running");
  await scan(progress);
});

ipcMain.handle("stop-scanning", () => stopScanning());
ipcMain.handle("show-shop", () => shopWindow?.focus());
ipcMain.handle("open-local-market", async () => {
  if (!localUrl) throw new Error("本地行情中心尚未啟動。");
  await shell.openExternal(localUrl);
});
ipcMain.handle("import-catalog", (_event, csv) => {
  if (importInProgress) throw new Error("行情匯入中，請稍後匯入商品索引。");
  if (typeof csv !== "string" || csv.length > 1024 * 1024) throw new Error("CSV 不可超過 1 MB。");
  const count = marketStore.importCatalog(parseCsv(csv));
  appWindow?.webContents.send("market-status", marketStore.status());
  return count;
});
ipcMain.handle("import-market-file", async (_event, input) => {
  if (scanInProgress || importInProgress || deliveryInProgress) {
    throw new Error("目前有掃描、通知或匯入作業，請稍後重試。");
  }
  if (typeof input?.content !== "string" ||
      Buffer.byteLength(input.content) > 5 * 1024 * 1024) {
    throw new Error("匯入檔案不可超過 5 MB。");
  }
  new AuthorizedFileAdapter(input.sourceId, input.authorizationReference)
    .validateConfiguration();
  importInProgress = true;
  try {
    const report = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "import_worker.cjs"), {
        workerData: { filename: path.join(app.getPath("userData"), "market.sqlite"),
          input, ratio: thresholdRatio }
      });
      let result;
      worker.once("message", (message) => { result = message; });
      worker.once("error", reject);
      worker.once("exit", (code) => code === 0 && result?.ok ? resolve(result.report) :
        reject(new Error(result?.error ?? "匯入工作者異常結束")));
    });
    appWindow?.webContents.send("market-status", marketStore.status());
    return report;
  } finally { importInProgress = false; }
});
ipcMain.handle("retry-uncertain-alert", (_event, key) => {
  if (importInProgress) throw new Error("行情匯入中，請稍後重試通知。");
  if (typeof key !== "string" || key.length > 200) throw new Error("警報 ID 無效");
  return marketStore.retryUncertainDelivery(key);
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

if (hasSingleInstanceLock) app.on("second-instance", () => {
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.show();
    appWindow.focus();
  }
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  logStartup("APP_READY");
  marketStore = new MarketStore(path.join(app.getPath("userData"), "market.sqlite"));
  marketStore.markInterruptedDeliveries?.();
  logStartup("STORE_READY");
  discordWebhook = loadWebhook();
  pausedScan = loadCheckpoint();
  if (marketStore.db) {
    const configuredFreshness = Number(process.env.ROZ_FRESHNESS_MINUTES || 15);
    localServer = createLocalServer(new MarketRepository(marketStore,
      { freshnessMinutes: configuredFreshness }), {
      syncStatus: () => ({ state: importInProgress ? "SYNCING" : pausedScan ?
        pausedScan.pauseReason === "AUTH_REQUIRED" ? "AUTH_REQUIRED" :
          pausedScan.pauseReason === "PARTIAL" ? "PARTIAL" : "PAUSED_CHALLENGE" :
        scanInProgress ? "SYNCING" :
          marketStore.status().lastRun?.status === "RATE_LIMITED" ? "RATE_LIMITED" : "IDLE",
      officialProgress: activeProgress || pausedScan ? {
        completedKeywords: (activeProgress ?? pausedScan).nextIndex,
        totalKeywords: (activeProgress ?? pausedScan).keywords.length,
        requestStats: (activeProgress ?? pausedScan).requestStats ?? { searches: 0, requests: 0 }
      } : null,
      activeSource: importInProgress ? "AUTHORIZED_IMPORT" :
        scanInProgress ? "gnjoy-ui" : null,
      asOf: new Date().toISOString() })
    });
    localUrl = await localServer.start();
  }
  createAppWindow();
  deliveryTimer = setInterval(() => deliverPendingAlerts().catch(() =>
    logEvent("DELIVERY_LOOP_FAILED")), 60000);
}).catch((error) => {
  logStartup("STARTUP_FAILED", error);
  dialog?.showErrorBox?.("ROZ 查價器啟動失敗", error.message);
  app.quit();
});
if (hasSingleInstanceLock) app.on("window-all-closed", () => {
  stopScanning();
  localServer?.close().catch((error) => logStartup("LOCAL_SERVER_CLOSE_FAILED", error));
  if (deliveryTimer) clearInterval(deliveryTimer);
  marketStore?.close();
  if (process.platform !== "darwin") app.quit();
});
