const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv } = require("./catalog.cjs");

test("imports quoted names, tiers and deduplicates names", () => {
  assert.deepEqual(parseCsv('itemName,tier\r\n"A, B",P0\r\nX,P2\r\nX,P1\r\n'), [
    { name: "A, B", tier: "P0" }, { name: "X", tier: "P1" }
  ]);
  assert.throws(() => parseCsv('itemName,tier\nX,P3'), /無效優先級/);
});
