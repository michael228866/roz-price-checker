const { parseResponse } = require("./market.cjs");

async function captureShopResponse(webContents, keyword) {
  const debuggerApi = webContents.debugger;
  if (!debuggerApi || debuggerApi.isAttached()) return null;
  const requests = new Map();
  let armed = false;
  let closed = false;
  let count = 0;
  let response = null;
  let status = "pending";
  const onMessage = async (_event, method, params) => {
    if (closed || !armed) return;
    if (method === "Network.requestWillBeSent" && /forAjax_shopDeal/i.test(params.request?.url ?? "")) {
      let requestUrl;
      try { requestUrl = new URL(params.request.url); } catch { return; }
      if (requestUrl.origin !== "https://event.gnjoy.com.tw") return;
      const body = params.request.postData;
      if (params.request.method !== "POST" || typeof body !== "string") return;
      let requestedKeyword;
      try { requestedKeyword = new URLSearchParams(body).get("txb_KeyWord"); }
      catch { return; }
      if (requestedKeyword !== keyword) return;
      count += 1;
      if (count > 1) status = "ambiguous";
      requests.set(params.requestId, { status: null, headers: {} });
    }
    const request = requests.get(params.requestId);
    if (!request) return;
    if (method === "Network.responseReceived") {
      request.status = params.response.status;
      request.headers = params.response.headers ?? {};
    }
    if (method !== "Network.loadingFinished") return;
    requests.delete(params.requestId);
    if (count !== 1) return;
    if (request.status === 403 || request.status === 429) {
      const retryAfter = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
      response = { rateLimited: true, retryAfter };
      status = "ready";
      return;
    }
    if (request.status !== 200) { status = "invalid"; return; }
    try {
      const result = await debuggerApi.sendCommand("Network.getResponseBody", { requestId: params.requestId });
      const body = result.base64Encoded
        ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
      response = parseResponse(JSON.parse(body), { keyword });
      status = response.errors.length ? "invalid" : "ready";
    } catch { status = "invalid"; }
  };
  try {
    debuggerApi.attach("1.3");
    debuggerApi.on("message", onMessage);
    await debuggerApi.sendCommand("Network.enable");
  } catch {
    if (debuggerApi.isAttached()) debuggerApi.detach();
    return null;
  }
  return {
    arm() { armed = true; },
    peek() { return { status, response }; },
    close() {
      closed = true;
      debuggerApi.removeListener("message", onMessage);
      if (debuggerApi.isAttached()) debuggerApi.detach();
    }
  };
}

function matchesVisible(rows, parsed) {
  if (!parsed || parsed.errors.length || rows.length !== parsed.items.length) return false;
  const counts = new Map();
  for (const item of parsed.items) {
    const key = JSON.stringify([item.shop, item.itemName, item.price, item.quantity]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const key = JSON.stringify([row.shop, row.itemName, row.price, row.quantity]);
    if (!counts.get(key)) return false;
    counts.set(key, counts.get(key) - 1);
  }
  return true;
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

module.exports = { captureShopResponse, enrichVisibleRows, matchesVisible };
