const test = require("node:test");
const assert = require("node:assert/strict");
const { parseResponse, analyze, fingerprint, fromVisibleRows } = require("./market.cjs");

function item(shop, price, refinement = 0) {
  return { shop, itemName: "Example", price, quantity: 1, storeType: "販售",
    serverId: 529, specification: fingerprint({ itemName: "Example", itemRefining: refinement }), specComplete: true };
}

test("parses valid response rows and isolates invalid prices without storing token", () => {
  const response = parseResponse({ dt: [
    { storeName: "A", itemName: "Example", itemPrice: 2000, itemCNT: 1600, storetype: 0 },
    { storeName: "B", itemName: "Example", itemPrice: -1, itemCNT: 1 }
  ], dt2: [{ count: 2 }], token: "secret" });
  assert.equal(response.items.length, 1);
  assert.equal(response.errors.length, 1);
  assert.equal(response.reportedCount, 2);
  assert.equal(response.paginationStatus, "PAGINATION_UNVERIFIED");
  assert.doesNotMatch(JSON.stringify(response), /secret/);
});

test("uses other sellers and matching specifications for the baseline", () => {
  const cheap = item("cheap", 1000);
  const results = analyze([cheap, item("B", 10000), item("C", 10000),
    item("D", 10000), item("D", 10000), item("E", 100, 1)]);
  const result = results.find((entry) => entry.shop === "cheap");
  assert.equal(result.referencePrice, 10000);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.confidence, "MEDIUM");
  assert.equal(result.anomalyType, "POSSIBLE_MISSING_ZERO");
  assert.equal(result.missingZeroMatch, true);
});

test("visible rows never claim complete item specifications", () => {
  const rows = fromVisibleRows([{ shop: "A", itemName: "Example", slots: "1", price: 1000,
    quantity: 1, storeType: "販售" }], "Example");
  assert.equal(rows[0].specComplete, false);
});
