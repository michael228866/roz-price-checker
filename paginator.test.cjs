const test = require("node:test");
const assert = require("node:assert/strict");
const { collectPages } = require("./paginator.cjs");

test("marks verified final page complete only when count matches", async () => {
  const pages = [
    { items: [{ shop: "A", specification: "s", price: 1, quantity: 1 }], reportedCount: 2, hasNext: true },
    { items: [{ shop: "B", specification: "s", price: 2, quantity: 1 }], reportedCount: 2, hasNext: false, countVerified: true }
  ];
  const result = await collectPages((page) => pages[page - 1]);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.pageCount, 2);
});

test("repeated page is partial even when the reported count appears complete", async () => {
  const item = { shop: "A", itemName: "Sword", specification: "s", price: 1, quantity: 1 };
  const result = await collectPages((page) => ({ items: [item], reportedCount: 1,
    hasNext: page === 1, countVerified: true }));
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.items.length, 1);
});

test("unverified count cannot declare a page complete", async () => {
  const result = await collectPages(async () => ({ items: [], reportedCount: 0, hasNext: false }));
  assert.equal(result.status, "PARTIAL");
});

test("unknown next-page control cannot be called complete", async () => {
  const result = await collectPages(async () => ({ items: [], reportedCount: 0, hasNext: null }));
  assert.equal(result.status, "PAGINATION_UNVERIFIED");
});
