const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MarketStore } = require("./store.cjs");
const { fromVisibleRows } = require("./market.cjs");

test("stores catalog, observations and one alert per event", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-market-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    store.importCatalog([{ name: "Example", tier: "P0" }]);
    const item = fromVisibleRows([{ shop: "A", itemName: "Example", slots: "1",
      price: 100, quantity: 1, storeType: "販售" }], "Example")[0];
    const run = store.startRun();
    store.saveObservations(run, [item], []);
    assert.equal(store.saveVisibleAlerts([{ ...item, referencePrice: 1000 }]).length, 1);
    assert.equal(store.saveVisibleAlerts([{ ...item, referencePrice: 1000 }]).length, 0);
    store.finishRun(run, "PARTIAL", { attempted: 1, succeeded: 1, listings: 1 });
    assert.deepEqual({ catalog: store.status().catalog, listings: store.status().listings,
      pendingAlerts: store.status().pendingAlerts }, { catalog: 1, listings: 1, pendingAlerts: 1 });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
