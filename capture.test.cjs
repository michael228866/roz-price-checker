const test = require("node:test");
const assert = require("node:assert/strict");
const { enrichVisibleRows } = require("./capture.cjs");

test("enriches only unambiguous normal UI response matches", () => {
  const row = { shop: "A", itemName: "Example", price: 100, quantity: 1, storeType: "販售" };
  const item = { ...row, specification: "full-spec", specComplete: true };
  assert.equal(enrichVisibleRows([row], { items: [item] })[0].specification, "full-spec");
  assert.equal(enrichVisibleRows([row], { items: [item, item] })[0].specification, undefined);
});
