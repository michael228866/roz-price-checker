const test = require("node:test");
const assert = require("node:assert/strict");
const { findCandidates, median } = require("./candidate.cjs");
const { fingerprint } = require("./market.cjs");

test("median handles odd and even input lengths", () => {
  assert.equal(median([10, 30, 20]), 20);
  assert.equal(median([10, 30, 20, 40]), 25);
});

test("flags only extreme sale prices against comparable listings", () => {
  const listings = [
    { shop: "A", itemName: "Example", slots: "1", price: 100000, storeType: "販售" },
    { shop: "B", itemName: "Example", slots: "1", price: 110000, storeType: "販售" },
    { shop: "C", itemName: "Example", slots: "1", price: 120000, storeType: "販售" },
    { shop: "D", itemName: "Example", slots: "1", price: 10000, storeType: "販售" },
    { shop: "E", itemName: "Example", slots: "2", price: 1000, storeType: "販售" },
    { shop: "F", itemName: "Example", slots: "1", price: 500, storeType: "收購" }
  ];

  const complete = listings.map((item) => ({ ...item, quantity: 1, serverId: 529,
    specification: fingerprint({ itemName: item.itemName, DefaultSlotCount: item.slots }),
    specComplete: true }));
  const result = findCandidates(complete);
  assert.equal(result.length, 1);
  assert.equal(result[0].shop, "D");
  assert.equal(result[0].referencePrice, 110000);
});

test("does not infer a bargain from fewer than three comparable listings", () => {
  const listings = [
    { shop: "A", itemName: "Example", slots: "-", price: 100000, storeType: "販售" },
    { shop: "B", itemName: "Example", slots: "-", price: 1000, storeType: "販售" }
  ];
  assert.deepEqual(findCandidates(listings), []);
});

test("keeps listings with different refine levels in separate price groups", () => {
  const listings = [
    { shop: "A", itemName: "+7 Example", slots: "1", price: 100000, storeType: "販售" },
    { shop: "B", itemName: "+7 Example", slots: "1", price: 110000, storeType: "販售" },
    { shop: "C", itemName: "+7 Example", slots: "1", price: 120000, storeType: "販售" },
    { shop: "D", itemName: "+10 Example", slots: "1", price: 1000, storeType: "販售" }
  ];

  assert.deepEqual(findCandidates(listings), []);
});

test("does not count the same listing from two keywords twice", () => {
  const cheap = { shop: "A", itemName: "Example", slots: "1", price: 1000, quantity: 1, storeType: "販售" };
  const normal = { shop: "B", itemName: "Example", slots: "1", price: 100000, quantity: 1, storeType: "販售" };
  assert.deepEqual(findCandidates([cheap, normal, { ...normal, keyword: "other" }]), []);
});

test("incomplete visible specifications cannot produce price alerts", () => {
  const listings = [100000, 110000, 120000, 1000].map((price, index) => ({
    shop: String(index), itemName: "Example", slots: "1", price, storeType: "販售",
    serverId: 529, specification: fingerprint({ itemName: "Example", DefaultSlotCount: "1" }),
    specComplete: false
  }));
  assert.deepEqual(findCandidates(listings), []);
});
