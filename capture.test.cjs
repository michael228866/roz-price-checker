const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { captureShopResponse, captureShopLocation, enrichVisibleRows, matchesVisible } = require("./capture.cjs");
const { parseResponse } = require("./market.cjs");

test("enriches only unambiguous normal UI response matches", () => {
  const row = { shop: "A", itemName: "Example", price: 100, quantity: 1, storeType: "販售" };
  const item = { ...row, specification: "full-spec", specComplete: true };
  assert.equal(enrichVisibleRows([row], { items: [item] })[0].specification, "full-spec");
  assert.equal(enrichVisibleRows([row], { items: [item, item] })[0].specification, undefined);
});

test("matches only the armed search request and its own response", async () => {
  const debuggerApi = new EventEmitter();
  let counted = 0;
  let attached = false;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command) => command === "Network.getResponseBody"
    ? { body: JSON.stringify({ dt: [{ storeName: "A", itemName: "Wanted", itemPrice: 100,
      itemCNT: 1, storetype: 0 }], dt2: [{ count: 1 }] }) } : {};
  const capture = await captureShopResponse({ debugger: debuggerApi }, "Wanted", 1,
    () => { counted += 1; });
  capture.arm();
  const request = (requestId, keyword, serverId = "529") => debuggerApi.emit("message", null, "Network.requestWillBeSent", {
    requestId, request: { method: "POST", url: "https://event.gnjoy.com.tw/forAjax_shopDeal",
      postData: JSON.stringify({ txb_KeyWord: keyword, div_svr: serverId, row_start: "1" }) }
  });
  request("other-server", "Wanted", "999");
  assert.equal(capture.peek().matchedRequests, 0);
  request("wrong", "Other");
  assert.equal(counted, 0);
  debuggerApi.emit("message", null, "Network.responseReceived", {
    requestId: "wrong", response: { status: 200 }
  });
  debuggerApi.emit("message", null, "Network.loadingFinished", { requestId: "wrong" });
  assert.equal(capture.peek().status, "pending");
  request("right", "Wanted");
  assert.equal(counted, 1);
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
  assert.equal(counted, 2);
  assert.equal(capture.peek().status, "ambiguous");
  capture.close();
});

test("matches search when CDP omits postData from the first event", async () => {
  const debuggerApi = new EventEmitter();
  let attached = false;
  let releaseBody;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command) => {
    if (command === "Network.getRequestPostData") {
      await new Promise((resolve) => { releaseBody = resolve; });
      return { postData: JSON.stringify({ txb_KeyWord: "Wanted",
        div_svr: "529", row_start: "1" }) };
    }
    if (command === "Network.getResponseBody") {
      return { body: JSON.stringify({ dt: [{ storeName: "A", itemName: "Wanted",
        itemPrice: 100, itemCNT: 1 }], dt2: [{ count: 1 }] }) };
    }
    return {};
  };
  const capture = await captureShopResponse({ debugger: debuggerApi }, "Wanted");
  capture.arm();
  debuggerApi.emit("message", null, "Network.requestWillBeSent", {
    requestId: "late-body", request: { method: "POST",
      url: "https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch/forAjax_shopDeal" }
  });
  debuggerApi.emit("message", null, "Network.responseReceived", {
    requestId: "late-body", response: { status: 200 }
  });
  debuggerApi.emit("message", null, "Network.loadingFinished", { requestId: "late-body" });
  assert.equal(capture.peek().status, "pending");
  releaseBody();
  await new Promise(setImmediate);
  assert.equal(capture.peek().status, "ready");
  assert.equal(capture.peek().matchedRequests, 1);
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
  assert.equal(await captureShopLocation({ debugger: debuggerApi },
    { ...listing, serverId: 999 }, click), null);
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

test("official decorated item names and trimmed shop names match the visible table", () => {
  const parsed = parseResponse({ dt: [{ SSI2: "42", storeName: "  Shop  ",
    itemName: "Sword", itemRefining: 7, ItemGradeLevel: 2,
    slot_1: "Card", RandomOpt1: "STR+1", itemPrice: 100,
    itemCNT: 1, storetype: 0 }] });
  const rows = [{ ssi: "42", shop: "Shop", itemName: "+7 C階 Sword Card STR+1",
    price: 100, quantity: 1 }];
  assert.equal(matchesVisible(rows, parsed), true);
  assert.equal(enrichVisibleRows(rows, parsed)[0].specification,
    parsed.items[0].specification);
  assert.equal(matchesVisible([{ ...rows[0], ssi: "43" }], parsed), false);
});
