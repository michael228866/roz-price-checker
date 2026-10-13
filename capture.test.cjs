const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { captureShopResponse, enrichVisibleRows, matchesVisible } = require("./capture.cjs");

test("enriches only unambiguous normal UI response matches", () => {
  const row = { shop: "A", itemName: "Example", price: 100, quantity: 1, storeType: "販售" };
  const item = { ...row, specification: "full-spec", specComplete: true };
  assert.equal(enrichVisibleRows([row], { items: [item] })[0].specification, "full-spec");
  assert.equal(enrichVisibleRows([row], { items: [item, item] })[0].specification, undefined);
});

test("matches only the armed search request and its own response", async () => {
  const debuggerApi = new EventEmitter();
  let attached = false;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command) => command === "Network.getResponseBody"
    ? { body: JSON.stringify({ dt: [{ storeName: "A", itemName: "Wanted", itemPrice: 100,
      itemCNT: 1, storetype: 0 }], dt2: [{ count: 1 }] }) } : {};
  const capture = await captureShopResponse({ debugger: debuggerApi }, "Wanted");
  capture.arm();
  const request = (requestId, keyword) => debuggerApi.emit("message", null, "Network.requestWillBeSent", {
    requestId, request: { method: "POST", url: "https://event.gnjoy.com.tw/forAjax_shopDeal",
      postData: `txb_KeyWord=${keyword}` }
  });
  request("wrong", "Other");
  debuggerApi.emit("message", null, "Network.responseReceived", {
    requestId: "wrong", response: { status: 200 }
  });
  debuggerApi.emit("message", null, "Network.loadingFinished", { requestId: "wrong" });
  assert.equal(capture.peek().status, "pending");
  request("right", "Wanted");
  debuggerApi.emit("message", null, "Network.responseReceived", {
    requestId: "right", response: { status: 200 }
  });
  debuggerApi.emit("message", null, "Network.loadingFinished", { requestId: "right" });
  await new Promise(setImmediate);
  assert.equal(capture.peek().status, "ready");
  const rows = [{ shop: "A", itemName: "Wanted", price: 100, quantity: 1 }];
  assert.equal(matchesVisible(rows, capture.peek().response), true);
  assert.equal(matchesVisible([{ ...rows[0], price: 200 }], capture.peek().response), false);
  request("duplicate", "Wanted");
  assert.equal(capture.peek().status, "ambiguous");
  capture.close();
});
