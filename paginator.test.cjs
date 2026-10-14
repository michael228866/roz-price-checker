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

test("collects the verified second page through the supplied UI fetcher", async () => {
  const visited = [];
  const result = await collectPages(async (page) => {
    visited.push(page);
    return { items: [{ shop: `shop-${page}`, ssi: `id-${page}`,
      specification: "spec", price: page, quantity: 1 }],
    reportedCount: 2, hasNext: page === 1, countVerified: true };
  });
  assert.deepEqual(visited, [1, 2]);
  assert.equal(result.items.length, 2);
  assert.equal(result.status, "COMPLETE");
});

test("different SSI listings with identical shop, specification and price remain distinct", async () => {
  const result = await collectPages((page) => ({ items: [{ shop: "A", ssi: `ssi-${page}`,
    specification: "same", price: 100, quantity: 1 }], reportedCount: 2,
  hasNext: page === 1, countVerified: true }));
  assert.equal(result.items.length, 2);
  assert.equal(result.status, "COMPLETE");
});

test("changing reported totals during paging marks the scan partial", async () => {
  const result = await collectPages(async (page) => ({
    items: [{ serverId: 529, shop: `Shop${page}`, ssi: `${page}`,
      itemName: "Stone", specification: "spec", price: 100, quantity: 1 }],
    reportedCount: page === 1 ? 2 : 3, hasNext: page === 1,
    countVerified: true
  }));
  assert.equal(result.status, "PARTIAL");
});
