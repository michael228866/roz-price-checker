const test = require("node:test");
const assert = require("node:assert/strict");
const { scanKeywordPages } = require("./shop_scanner.cjs");

function fixture(count = 31) {
  const pages = [Array.from({ length: Math.min(count, 30) }, (_, index) => ({
    shop: `Shop${index}`, itemName: "Stone", ssi: `SSI${index}`,
    specification: "spec", price: 100, quantity: 1,
    storeType: "販售", rowIndex: index
  }))];
  if (count > 30) pages.push(Array.from({ length: count - 30 }, (_, index) => ({
    shop: `Shop${index + 30}`, itemName: "Stone", ssi: `SSI${index + 30}`,
    specification: "spec", price: 100, quantity: 1,
    storeType: "販售", rowIndex: index
  })));
  let current = 0;
  const requested = [];
  const webContents = { executeJavaScript: async (script) => {
    if (script.includes("getClientRects")) return false;
    if (script.includes("return { started: true }")) {
      if (script.includes("const page = 2;")) {
        assert.ok(script.includes("'javascript:goPage(' + page + ')'"));
      }
      current = script.includes("const page = 2;") ? 1 : 0;
      return { started: true };
    }
    if (script.includes("const rows =")) return { output: pages[current],
      loading: false, activePage: current + 1,
      hasNextControl: current < pages.length - 1,
      serverId: "529", messageText: "" };
    return true;
  } };
  const captureSearch = async (_contents, _keyword, rowStart) => {
    requested.push(rowStart);
    const page = (rowStart - 1) / 30;
    return { arm() {}, close() {}, peek: () => ({ status: "ready",
      response: { items: pages[page], reportedCount: count } }) };
  };
  return { webContents, captureSearch, requested };
}

test("normal UI scanner collects page two and accepts identical settled DOM", async () => {
  const setup = fixture();
  const result = await scanKeywordPages(setup.webContents, "Stone", {
    captureSearch: setup.captureSearch, wait: async () => {},
    rowsMatch: () => true, enrichRows: (rows) => rows
  });
  assert.deepEqual(setup.requested, [1, 31]);
  assert.equal(result.items.length, 31);
  assert.equal(result.status, "COMPLETE");
});

test("visible verification pauses before sending a search", async () => {
  const setup = fixture(1);
  let captures = 0;
  setup.webContents.executeJavaScript = async (script) => {
    assert.ok(script.includes("getClientRects"));
    return true;
  };
  await assert.rejects(scanKeywordPages(setup.webContents, "Stone", {
    captureSearch: async () => { captures += 1; }
  }), /圖形驗證/);
  assert.equal(captures, 0);
});

test("final candidate receives only coordinates from its exact current listing", async () => {
  const setup = fixture(1);
  const target = { serverId: 529, keyword: "Stone",
    shop: "Shop0", itemName: "Stone", ssi: "SSI0", specification: "spec",
    price: 100, quantity: 1 };
  let lookups = 0;
  const result = await scanKeywordPages(setup.webContents, "Stone", {
    captureSearch: setup.captureSearch, wait: async () => {},
    rowsMatch: () => true, enrichRows: (rows) => rows,
    targets: [target], captureLocation: async () => {
      lookups += 1;
      return { mapName: "prontera", x: 162, y: 92,
        source: "shop_detail_response", confidence: "MATCHED_SHOP_DETAIL" };
    }
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(lookups, 1);
  assert.equal(target._confirmed, true);
  assert.equal(target.location.x, 162);
});

test("mismatched SSI cannot inherit another shop's location", async () => {
  const setup = fixture(1);
  const target = { serverId: 529, keyword: "Stone", shop: "Shop0",
    itemName: "Stone", ssi: "OTHER", specification: "spec",
    price: 100, quantity: 1 };
  let lookups = 0;
  await scanKeywordPages(setup.webContents, "Stone", {
    captureSearch: setup.captureSearch, wait: async () => {},
    rowsMatch: () => true, enrichRows: (rows) => rows,
    targets: [target], captureLocation: async () => { lookups += 1; return null; }
  });
  assert.equal(lookups, 0);
  assert.equal(target._confirmed, undefined);
});

test("a sold listing is not confirmed when its price or quantity changed", async () => {
  const setup = fixture(1);
  const target = { serverId: 529, keyword: "Stone", shop: "Shop0",
    itemName: "Stone", ssi: "SSI0", specification: "spec",
    price: 100, quantity: 2 };
  let lookups = 0;
  await scanKeywordPages(setup.webContents, "Stone", {
    captureSearch: setup.captureSearch, wait: async () => {},
    rowsMatch: () => true, enrichRows: (rows) => rows,
    targets: [target], captureLocation: async () => { lookups += 1; return null; }
  });
  assert.equal(lookups, 0);
  assert.equal(target._confirmed, undefined);
});
