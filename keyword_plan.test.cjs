const test = require("node:test");
const assert = require("node:assert/strict");
const { planKeywords } = require("./keyword_plan.cjs");

test("catalog keeps four slots when manual tracking has twenty names", () => {
  const manual = Array.from({ length: 20 }, (_, index) => `manual-${index}`);
  const catalog = Array.from({ length: 4 }, (_, index) => `catalog-${index}`);
  const first = planKeywords({ manual, catalog, cursor: 0 });
  const second = planKeywords({ manual, catalog, cursor: first.nextCursor });
  assert.equal(first.keywords.length, 20);
  assert.equal(first.catalogDue.length, 4);
  assert.deepEqual(first.keywords.slice(-4), catalog);
  assert.ok(second.keywords.includes("manual-16"));
  assert.ok(second.keywords.includes("catalog-0"));
});
