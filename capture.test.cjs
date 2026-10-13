const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { captureShopResponse, captureShopLocation, enrichVisibleRows, matchesVisible } = require("./capture.cjs");

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
      postData: JSON.stringify({ txb_KeyWord: keyword }) }
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

test("shop details bind coordinates to the clicked SSI and exact listing", async () => {
  const debuggerApi = new EventEmitter();
  let attached = false;
  let detail = { SSI2: "store-1", storeName: "Same Name", itemName: "Sword",
    itemPrice: 100, itemCNT: 1, mapName: "prontera.gat", xPos: 162, yPos: 92 };
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command) => command === "Network.getResponseBody"
    ? { body: JSON.stringify({ dt: [detail] }) } : {};
  const listing = { ssi: "store-1", serverId: 529, shop: "Same Name",
    rawItemName: "Sword", price: 100, quantity: 1 };
  const click = async () => {
    debuggerApi.emit("message", null, "Network.requestWillBeSent", {
      requestId: "detail", request: { method: "POST",
        url: "https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch/forAjax_shopDeal_a_store",
        postData: JSON.stringify({ SSI: "store-1", div_svr: "529" }) }
    });
    debuggerApi.emit("message", null, "Network.responseReceived", {
      requestId: "detail", response: { status: 200 }
    });
    debuggerApi.emit("message", null, "Network.loadingFinished", { requestId: "detail" });
    return true;
  };
  const first = await captureShopLocation({ debugger: debuggerApi }, listing, click);
  assert.deepEqual(first && [first.mapName, first.x, first.y], ["prontera", 162, 92]);
  detail = { ...detail, SSI2: "store-2", xPos: 99 };
  assert.equal(await captureShopLocation({ debugger: debuggerApi }, listing, click), null);
  detail = { ...detail, SSI2: "store-1", xPos: 120, yPos: 80 };
  const moved = await captureShopLocation({ debugger: debuggerApi }, listing, click);
  assert.deepEqual(moved && [moved.mapName, moved.x, moved.y], ["prontera", 120, 80]);
});

test("same-name shops match their own SSI instead of borrowing coordinates", () => {
  const rows = [{ shop: "Same Name", ssi: "1", itemName: "Sword", price: 100, quantity: 1 },
    { shop: "Same Name", ssi: "2", itemName: "Sword", price: 100, quantity: 1 }];
  const parsed = { items: [{ ...rows[0], specification: "spec1", specComplete: true },
    { ...rows[1], specification: "spec2", specComplete: true }], errors: [] };
  assert.equal(matchesVisible(rows, parsed), true);
  assert.deepEqual(enrichVisibleRows(rows, parsed).map((row) => row.specification), ["spec1", "spec2"]);
});
