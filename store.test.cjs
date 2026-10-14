const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MarketStore } = require("./store.cjs");
const { DatabaseSync } = require("node:sqlite");
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

test("alert location is a per-event snapshot and never borrows a previous position", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-location-"));
  const filename = path.join(directory, "market.sqlite");
  const store = new MarketStore(filename);
  try {
    const base = { serverId: 529, shop: "Same Name", itemName: "Sword",
      specification: "full-spec", specComplete: true, storeType: "販售",
      price: 100, quantity: 1 };
    const save = (location) => {
      const item = { ...base, location };
      return store.saveObservations(store.startRun(), [item], [{ ...item,
        referencePrice: 1000, sampleCount: 3, confidence: "MEDIUM",
        anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 }]);
    };
    assert.equal(save({ mapName: "prontera", x: 162, y: 92,
      source: "shop_detail_response", confidence: "MATCHED_SHOP_DETAIL" }).length, 1);
    assert.equal(save({ mapName: "prontera", x: 120, y: 80,
      source: "shop_detail_response", confidence: "MATCHED_SHOP_DETAIL" }).length, 0);
    assert.equal(save({ mapName: "prontera", x: 1, y: 1,
      source: "unconfirmed", confidence: "LOW" }).length, 0);
    const alerts = store.pendingAlerts();
    assert.deepEqual(alerts.map((alert) => [alert.mapName, alert.x, alert.y]),
      [["prontera", 162, 92]]);
    assert.equal(store.db.prepare("SELECT location_map FROM listings LIMIT 1").get().location_map, null);
  } finally {
    store.close();
  }
  const reopened = new MarketStore(filename);
  try { assert.equal(reopened.pendingAlerts().length, 1); }
  finally {
    reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy SQLite rows survive the additive location migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-legacy-"));
  const filename = path.join(directory, "market.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE listings (
    key TEXT PRIMARY KEY, server_id INTEGER NOT NULL, shop TEXT NOT NULL,
    item_name TEXT NOT NULL, specification TEXT NOT NULL, price INTEGER NOT NULL,
    quantity INTEGER NOT NULL, spec_complete INTEGER NOT NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE price_alerts (
    key TEXT PRIMARY KEY, listing_key TEXT NOT NULL REFERENCES listings(key),
    type TEXT NOT NULL, price INTEGER NOT NULL, reference_price REAL NOT NULL,
    confidence TEXT NOT NULL, created_at TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, next_attempt_at TEXT);
    INSERT INTO listings VALUES ('old', 529, 'Shop', 'Sword', 'spec', 100, 1, 1, '2026', '2026');
    INSERT INTO price_alerts (key, listing_key, type, price, reference_price,
      confidence, created_at) VALUES ('alert', 'old', 'LOW', 100, 1000, 'MEDIUM', '2026');`);
  legacy.close();
  const store = new MarketStore(filename);
  try {
    assert.equal(store.status().listings, 1);
    assert.equal(store.pendingAlerts()[0].mapName, null);
    assert.equal(store.db.prepare("SELECT key FROM price_alerts").get().key, "alert");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinates do not create a second event for an unchanged price", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-event-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const base = { serverId: 529, shop: "Shop", ssi: "one", itemName: "Sword",
      specification: "full", specComplete: true, storeType: "販售",
      price: 100, quantity: 1, referencePrice: 1000, sampleCount: 3,
      confidence: "MEDIUM", anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 };
    assert.equal(store.saveObservations(store.startRun(), [base], [base]).length, 1);
    const located = { ...base, location: { mapName: "prontera", x: 1, y: 2,
      source: "shop_detail_response", confidence: "MATCHED_SHOP_DETAIL" } };
    assert.equal(store.saveObservations(store.startRun(), [located], [located]).length, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects observations from another server", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-server-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const item = { serverId: 999, shop: "Shop", itemName: "Sword",
      specification: "full", specComplete: true, storeType: "販售",
      price: 100, quantity: 1 };
    assert.throws(() => store.saveObservations(store.startRun(), [item], []), /529/);
    assert.equal(store.status().listings, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("old asking snapshots are archival data, not active market references", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-active-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const item = { serverId: 529, shop: "Shop", ssi: "one", itemName: "Sword",
      specification: "full", specComplete: true, storeType: "販售",
      price: 1000, quantity: 1 };
    const run = store.startRun();
    store.saveObservations(run, [item], []);
    assert.equal(store.historicalReferences()[0].marketKind, "ASK_HISTORY");
    assert.equal(store.activeReferences(new Date(Date.now() + 16 * 60000)).length, 0);
    assert.equal(store.transactionReferences().length, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
