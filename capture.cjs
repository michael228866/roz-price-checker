const { parseResponse } = require("./market.cjs");

async function captureShopResponse(webContents, keyword) {
  const debuggerApi = webContents.debugger;
  if (!debuggerApi || debuggerApi.isAttached()) return { result: Promise.resolve(null), close() {} };
  let finished = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const requests = new Map();
  const close = () => {
    if (finished) return;
    finished = true;
    debuggerApi.removeListener("message", onMessage);
    if (debuggerApi.isAttached()) debuggerApi.detach();
    resolveResult(null);
  };
  const onMessage = async (_event, method, params) => {
    if (method === "Network.responseReceived" && /forAjax_shopDeal/i.test(params.response?.url ?? "")) {
      requests.set(params.requestId, params.response.status);
    }
    if (method !== "Network.loadingFinished" || !requests.has(params.requestId)) return;
    const status = requests.get(params.requestId);
    requests.delete(params.requestId);
    if (status === 403 || status === 429) {
      if (!finished) resolveResult({ rateLimited: true });
      return;
    }
    try {
      const response = await debuggerApi.sendCommand("Network.getResponseBody", { requestId: params.requestId });
      const body = response.base64Encoded
        ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
      const parsed = parseResponse(JSON.parse(body), { keyword });
      if (!finished) resolveResult(parsed);
    } catch {
      if (!finished) resolveResult(null);
    }
  };
  try {
    debuggerApi.attach("1.3");
    debuggerApi.on("message", onMessage);
    await debuggerApi.sendCommand("Network.enable");
  } catch { close(); }
  return { result, close };
}

function enrichVisibleRows(rows, parsed) {
  if (!parsed) return rows;
  const used = new Set();
  return rows.map((row) => {
    const matches = parsed.items.map((item, index) => ({ item, index })).filter(({ item, index }) =>
      !used.has(index) && item.shop === row.shop && item.itemName === row.itemName &&
      item.price === row.price && item.quantity === row.quantity);
    if (matches.length !== 1) return row;
    used.add(matches[0].index);
    return { ...row, specification: matches[0].item.specification,
      specComplete: matches[0].item.specComplete, source: "ui_response" };
  });
}

module.exports = { captureShopResponse, enrichVisibleRows };
