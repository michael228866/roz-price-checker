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
    const second = store.startRun();
    store.saveObservations(second, [{ ...item, price: 90, quantity: 2 }], []);
    store.finishRun(second, "PARTIAL");
    assert.equal(store.status().listings, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM listing_versions").get().count, 2);
    assert.equal(store.historicalReferences().length, 0); // Visible rows lack full specifications.
    store.markKeyword("Example", true);
    assert.equal(store.status().coverage.scanned, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("P0 P1 P2 due keywords all receive slots and retry deadlines are respected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-schedule-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    store.importCatalog(["P0", "P1", "P2"].flatMap((tier) =>
      Array.from({ length: 10 }, (_, index) => ({ name: `${tier}-${index}`, tier }))));
    const due = store.dueCatalog(20);
    assert.equal(due.length, 20);
    assert.deepEqual(new Set(due.map((item) => item.tier)), new Set(["P0", "P1", "P2"]));
    const run = store.startRun();
    const item = fromVisibleRows([{ shop: "A", itemName: "Example", slots: "1",
      price: 100, quantity: 1, storeType: "販售" }], "Example")[0];
    store.saveObservations(run, [item], []);
    const [alert] = store.saveVisibleAlerts([{ ...item, referencePrice: 1000 }]);
    store.markDelivery(alert.alertKey, "pending", "HTTP_429",
      new Date(Date.now() + 60000).toISOString(), false);
    assert.equal(store.pendingAlerts().length, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
