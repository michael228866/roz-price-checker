const { SERVER_ID, parseResponse } = require("./market.cjs");
const { parseShopLocation } = require("./shop_location.cjs");

function sameListing(row, item) {
  const identity = (row.ssi ?? null) === (item.ssi ?? null);
  return identity && row.itemName === (item.displayName ?? item.itemName) &&
    row.shop === item.shop && row.price === item.price &&
    row.quantity === item.quantity;
}

async function captureShopResponse(webContents, keyword, rowStart = 1, onRequest = () => {}) {
  const debuggerApi = webContents.debugger;
  if (!debuggerApi || debuggerApi.isAttached()) return null;
  const requests = new Map();
  let armed = false;
  let closed = false;
  let count = 0;
  let searchRequests = 0;
  let unreadableRequests = 0;
  let response = null;
  let status = "pending";
  const finishRequest = async (requestId, request) => {
    if (!request.matched || (!request.finished && !request.failed) ||
        closed || status === "ambiguous") return;
    requests.delete(requestId);
    if (count !== 1) return;
    if (request.failed) { status = "invalid"; return; }
    if (request.status === 403 || request.status === 429) {
      const retryAfter = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
      response = { rateLimited: true, retryAfter };
      status = "ready";
      return;
    }
    if (request.status !== 200) { status = "invalid"; return; }
    try {
      const result = await debuggerApi.sendCommand("Network.getResponseBody", { requestId });
      if (closed || status === "ambiguous") return;
      const body = result.base64Encoded
        ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
      response = parseResponse(JSON.parse(body), { keyword, serverId: SERVER_ID });
      status = response.errors.length ? "invalid" : "ready";
    } catch { status = "invalid"; }
  };
  const onMessage = async (_event, method, params) => {
    if (closed || !armed) return;
    if (method === "Network.requestWillBeSent") {
      let requestUrl;
      try { requestUrl = new URL(params.request.url); } catch { return; }
      if (requestUrl.origin !== "https://event.gnjoy.com.tw" ||
          !requestUrl.pathname.endsWith("/forAjax_shopDeal") ||
          params.request.method !== "POST") return;
      searchRequests += 1;
      const request = { status: null, headers: {}, matched: false, finished: false, failed: false };
      requests.set(params.requestId, request);
      let body = params.request.postData;
      if (typeof body !== "string") {
        try {
          body = (await debuggerApi.sendCommand("Network.getRequestPostData",
            { requestId: params.requestId })).postData;
        } catch {
          unreadableRequests += 1;
          requests.delete(params.requestId);
          return;
        }
      }
      if (closed) return;
      let input;
      try { input = JSON.parse(body); }
      catch { requests.delete(params.requestId); return; }
      if (input.txb_KeyWord !== keyword || Number(input.div_svr) !== SERVER_ID ||
          Number(input.row_start) !== rowStart) {
        requests.delete(params.requestId);
        return;
      }
      request.matched = true;
      count += 1;
      onRequest();
      if (count > 1) status = "ambiguous";
      await finishRequest(params.requestId, request);
      return;
    }
    const request = requests.get(params.requestId);
    if (!request) return;
    if (method === "Network.responseReceived") {
      request.status = params.response.status;
      request.headers = params.response.headers ?? {};
    }
    if (method === "Network.loadingFailed") {
      request.failed = true;
      await finishRequest(params.requestId, request);
      return;
    }
    if (method !== "Network.loadingFinished") return;
    request.finished = true;
    await finishRequest(params.requestId, request);
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
    peek() { return { status, response, searchRequests, matchedRequests: count,
      unreadableRequests }; },
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
    const key = JSON.stringify([item.shop, item.displayName ?? item.itemName,
      item.ssi, item.price, item.quantity]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const key = JSON.stringify([row.shop, row.itemName, row.ssi,
      row.price, row.quantity]);
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
      !used.has(index) && sameListing(row, item));
    if (matches.length !== 1) return row;
    used.add(matches[0].index);
    return { ...row, specification: matches[0].item.specification,
      specificationJson: matches[0].item.specificationJson,
      specComplete: matches[0].item.specComplete, ssi: matches[0].item.ssi,
      rawItemName: matches[0].item.itemName,
      source: "ui_response" };
  });
}

async function captureShopLocation(webContents, listing, clickShop) {
  if (!listing.ssi || listing.serverId !== SERVER_ID) return null;
  const debuggerApi = webContents.debugger;
  if (!debuggerApi || debuggerApi.isAttached()) return null;
  let requestId = null;
  let status = "pending";
  let location = null;
  let closed = false;
  const onMessage = async (_event, method, params) => {
    if (closed) return;
    if (method === "Network.requestWillBeSent") {
      let url;
      try { url = new URL(params.request?.url); } catch { return; }
      if (url.origin !== "https://event.gnjoy.com.tw" ||
          !url.pathname.endsWith("/forAjax_shopDeal_a_store") ||
          params.request.method !== "POST") return;
      let body;
      try { body = JSON.parse(params.request.postData); } catch { return; }
      if (String(body.SSI) !== listing.ssi || Number(body.div_svr) !== listing.serverId) return;
      if (requestId) { status = "ambiguous"; return; }
      requestId = params.requestId;
    }
    if (!requestId || params.requestId !== requestId) return;
    if (method === "Network.responseReceived" && params.response.status !== 200) status = "invalid";
    if (method !== "Network.loadingFinished" || status !== "pending") return;
    try {
      const result = await debuggerApi.sendCommand("Network.getResponseBody", { requestId });
      if (closed || status !== "pending") return;
      const text = result.base64Encoded
        ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.dt) || payload.Message) { status = "invalid"; return; }
      const matching = payload.dt.filter((row) =>
        (!row.SSI2 || String(row.SSI2) === listing.ssi) &&
        row.storeName === listing.shop && row.itemName === listing.rawItemName &&
        row.itemPrice === listing.price && row.itemCNT === listing.quantity);
      const positions = matching.map((row) => parseShopLocation(row)).filter(Boolean);
      if (positions.length === 1 && matching.length === 1) location = positions[0];
      status = "ready";
    } catch { status = "invalid"; }
  };
  try {
    debuggerApi.attach("1.3");
    debuggerApi.on("message", onMessage);
    await debuggerApi.sendCommand("Network.enable");
    const clicked = await clickShop();
    if (!clicked) return null;
    for (let attempt = 0; attempt < 20 && status === "pending"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return status === "ready" ? location : null;
  } finally {
    closed = true;
    debuggerApi.removeListener("message", onMessage);
    if (debuggerApi.isAttached()) debuggerApi.detach();
  }
}

module.exports = { captureShopResponse, captureShopLocation, enrichVisibleRows, matchesVisible };
