const test = require("node:test");
const assert = require("node:assert/strict");
const { parseShopLocation, navigationCommand } = require("./shop_location.cjs");

test("parses the official shop detail coordinate fields", () => {
  const location = parseShopLocation({ mapName: "prontera.gat", xPos: 162, yPos: "92" });
  assert.deepEqual(location, { mapName: "prontera", x: 162, y: 92,
    source: "shop_detail_response", confidence: "MATCHED_SHOP_DETAIL" });
  assert.equal(navigationCommand(location), "/navi prontera 162/92");
});

test("missing or unsafe location never produces a navigation command", () => {
  for (const row of [null, { mapName: "prontera.gat", xPos: 0, yPos: 92 },
    { mapName: "prontera;echo", xPos: 162, yPos: 92 },
    { mapName: "prontera.gat", xPos: "1/2", yPos: 92 },
    { mapName: "prontera.gat", xPos: 162 }]) {
    assert.equal(parseShopLocation(row), null);
  }
  assert.equal(navigationCommand(null), null);
});
