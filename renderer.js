const keywordsInput = document.querySelector("#keywords");
const ratioInput = document.querySelector("#ratio");
const includeHotInput = document.querySelector("#include-hot");
const includeCatalogInput = document.querySelector("#include-catalog");
const intervalInput = document.querySelector("#interval");
const startButton = document.querySelector("#start");
const resumeButton = document.querySelector("#resume");
const stopButton = document.querySelector("#stop");
const statusBox = document.querySelector("#status");
const resultsBox = document.querySelector("#results");
const lastScan = document.querySelector("#last-scan");
const alertDialog = document.querySelector("#alert-dialog");
const alertItems = document.querySelector("#alert-items");

const defaultKeywords = ["物理魔晶石", "魔靈石", "靈幻石"];
const savedKeywords = localStorage.getItem("keywords");
const keywords = savedKeywords !== null
  ? savedKeywords.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  : [];
keywordsInput.value = [...new Set([...keywords, ...defaultKeywords])].join("\n");
ratioInput.value = localStorage.getItem("ratio") || "15";
includeHotInput.checked = localStorage.getItem("includeHotKeywords") === "true";
includeCatalogInput.checked = localStorage.getItem("includeCatalog") === "true";
intervalInput.value = localStorage.getItem("intervalMinutes") || "10";

function showMarketStatus(status) {
  const coverage = status.coverage;
  document.querySelector("#market-status").textContent =
    `已知商品 ${status.catalog} 筆 · 已存掛單 ${status.listings} 筆 · 待送通知 ${status.pendingAlerts} 筆 · 最近掃描 ${status.lastRun?.status || "無"}`;
  if (coverage) document.querySelector("#market-status").textContent +=
    `・索引覆蓋 ${coverage.scanned ?? 0}/${coverage.known ?? 0}`;
}
window.shopAlert.marketStatus().then(showMarketStatus).catch((error) => setStatus(error.message, "error"));
window.shopAlert.onMarketStatus(showMarketStatus);
document.querySelector("#import-catalog").addEventListener("click", async () => {
  const file = document.querySelector("#catalog-file").files[0];
  if (!file) { setStatus("請先選取 CSV 檔案。", "error"); return; }
  try {
    const count = await window.shopAlert.importCatalog(await file.text());
    setStatus(`已匯入 ${count} 筆商品。`, "success");
  } catch (error) { setStatus(error.message, "error"); }
});
document.querySelector("#save-discord").addEventListener("click", async () => {
  try {
    await window.shopAlert.setDiscord(document.querySelector("#discord-webhook").value.trim());
    document.querySelector("#discord-webhook").value = "";
    setStatus("Discord Webhook 已加密儲存。", "success");
  } catch (error) { setStatus(error.message, "error"); }
});
document.querySelector("#clear-discord").addEventListener("click", async () => {
  try { await window.shopAlert.setDiscord(""); setStatus("Discord Webhook 已移除。", "success"); }
  catch (error) { setStatus(error.message, "error"); }
});

document.querySelector("#open-shop").addEventListener("click", () => window.shopAlert.openShop());
document.querySelector("#show-shop").addEventListener("click", () => window.shopAlert.showShop());
document.querySelector("#dismiss-alert").addEventListener("click", closeAlert);
document.querySelector("#confirm-alert").addEventListener("click", closeAlert);
alertDialog.addEventListener("click", (event) => {
  if (event.target === alertDialog) closeAlert();
});

startButton.addEventListener("click", async () => {
  const keywords = keywordsInput.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const ratio = Number(ratioInput.value) / 100;
  const includeHotKeywords = includeHotInput.checked;
  const includeCatalog = includeCatalogInput.checked;
  const intervalMinutes = Number(intervalInput.value);
  localStorage.setItem("keywords", keywordsInput.value);
  localStorage.setItem("ratio", ratioInput.value);
  localStorage.setItem("includeHotKeywords", String(includeHotKeywords));
  localStorage.setItem("includeCatalog", String(includeCatalog));
  localStorage.setItem("intervalMinutes", String(intervalMinutes));
  try {
    await window.shopAlert.startScanning({ keywords, ratio, includeHotKeywords, includeCatalog, intervalMinutes });
  } catch (error) {
    setStatus(error.message, "error");
  }
});

stopButton.addEventListener("click", () => window.shopAlert.stopScanning());
resumeButton.addEventListener("click", async () => {
  try {
    await window.shopAlert.resumeScanning();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

window.shopAlert.onStatus(({ message, state }) => setStatus(message, state));
window.shopAlert.onState((state) => {
  startButton.disabled = state === "running";
  resumeButton.hidden = state !== "paused";
  stopButton.disabled = state === "stopped";
});
window.shopAlert.onResults(({ checkedAt, listingCount, candidates }) => {
  lastScan.textContent = `最後掃描：${new Date(checkedAt).toLocaleString()}（${listingCount} 筆掛單）`;
  if (!candidates.length) return;
  resultsBox.classList.remove("empty");
  const cards = candidates.map((candidate) => {
    const article = document.createElement("article");
    article.className = "candidate";
    const title = document.createElement("strong");
    title.textContent = candidate.itemName;
    const detail = document.createElement("span");
    detail.textContent = `${candidate.price.toLocaleString()} Z／個 · 參考中位價 ${candidate.referencePrice.toLocaleString()} Z · ${candidate.shop}`;
    const meta = document.createElement("small");
    meta.textContent = `關鍵字「${candidate.keyword}」 · slot ${candidate.slots} · 數量 ${candidate.quantity}`;
    article.append(title, detail, meta, locationElement(candidate));
    return article;
  });
  resultsBox.prepend(...cards);
  showAlert(candidates);
});

function showAlert(candidates) {
  alertItems.replaceChildren(...candidates.map((candidate) => {
    const item = document.createElement("article");
    item.className = "alert-candidate";
    const name = document.createElement("strong");
    name.textContent = candidate.itemName;
    const price = document.createElement("span");
    price.textContent = `${candidate.price.toLocaleString()} Z／個`;
    const reference = document.createElement("small");
    reference.textContent = `參考中位價 ${candidate.referencePrice.toLocaleString()} Z · ${candidate.shop}`;
    item.append(name, price, reference, locationElement(candidate));
    return item;
  }));
  alertDialog.hidden = false;
  document.querySelector("#confirm-alert").focus();
}

function locationElement(candidate) {
  const container = document.createElement("div");
  const label = document.createElement("small");
  label.textContent = candidate.navigation
    ? `商店位置：${candidate.location.mapName} ${candidate.location.x}/${candidate.location.y}`
    : "商店位置：尚未取得商店位置";
  container.append(label);
  if (candidate.navigation) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.type = "button";
    button.textContent = "複製導航指令";
    button.addEventListener("click", async () => {
      try {
        await window.shopAlert.copyNavigation(candidate.navigation);
        button.textContent = "已複製";
      } catch { setStatus("複製失敗，請手動複製導航指令。", "error"); }
    });
    container.append(" ", button);
  }
  return container;
}

function closeAlert() {
  alertDialog.hidden = true;
}

function setStatus(message, state) {
  statusBox.textContent = message;
  statusBox.className = `status ${state || "info"}`;
}
