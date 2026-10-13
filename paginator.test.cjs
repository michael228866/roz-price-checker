const test = require("node:test");
const assert = require("node:assert/strict");
const { collectPages } = require("./paginator.cjs");

test("marks verified final page complete only when count matches", async () => {
  const pages = [
    { items: [{ shop: "A", specification: "s", price: 1, quantity: 1 }], reportedCount: 2, hasNext: true },
    { items: [{ shop: "B", specification: "s", price: 2, quantity: 1 }], reportedCount: 2, hasNext: false }
  ];
  const result = await collectPages((page) => pages[page - 1]);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.pageCount, 2);
});

test("unknown next-page control cannot be called complete", async () => {
  const result = await collectPages(async () => ({ items: [], reportedCount: 0, hasNext: null }));
  assert.equal(result.status, "PAGINATION_UNVERIFIED");
});
