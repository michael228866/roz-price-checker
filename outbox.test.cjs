const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MarketStore } = require("./store.cjs");

test("an interrupted Discord send becomes uncertain until manually retried", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-outbox-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO listings
      (key, server_id, shop, item_name, specification, price, quantity, spec_complete,
       first_seen, last_seen) VALUES ('listing', 529, 'shop', 'item', 'spec', 10, 1, 1, ?, ?)`)
      .run(now, now);
    store.db.prepare(`INSERT INTO price_alerts
      (key, listing_key, type, price, reference_price, confidence, created_at)
      VALUES ('alert', 'listing', 'POSSIBLE_MISSING_ZERO', 10, 100, 'HIGH', ?)`)
      .run(now);
    assert.equal(store.claimDelivery("alert"), true);
    assert.equal(store.pendingAlerts().length, 0);
    store.markInterruptedDeliveries();
    assert.equal(store.db.prepare("SELECT delivery_status FROM price_alerts WHERE key='alert'").get()
      .delivery_status, "uncertain");
    assert.equal(store.retryUncertainDelivery("alert"), true);
    assert.equal(store.pendingAlerts().length, 1);
    assert.equal(store.claimDelivery("alert"), true);
    store.markRateLimited("alert", new Date(Date.now() + 2500).toISOString());
    assert.equal(store.pendingAlerts().length, 0);
    assert.equal(store.db.prepare("SELECT attempts FROM price_alerts WHERE key='alert'").get().attempts, 0);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("confirmed bargain without coordinates becomes sendable with unknown location", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-unknown-location-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const old = new Date(Date.now() - 120000).toISOString();
    store.db.prepare(`INSERT INTO listings (key, server_id, shop, item_name,
      specification, price, quantity, spec_complete, first_seen, last_seen)
      VALUES ('listing', 529, 'shop', 'item', 'spec', 10, 1, 1, ?, ?)`).run(old, old);
    store.db.prepare(`INSERT INTO price_alerts (key, listing_key, type, price,
      reference_price, confidence, created_at, delivery_status, location_status)
      VALUES ('alert', 'listing', 'POSSIBLE_MISSING_ZERO', 10, 100, 'HIGH', ?,
      'location_pending', 'LOCATION_PENDING')`).run(old);
    assert.equal(store.pendingAlerts().length, 1);
    assert.equal(store.pendingAlerts()[0].mapName, null);
    assert.equal(store.db.prepare("SELECT location_status FROM price_alerts WHERE key='alert'").get()
      .location_status, "UNAVAILABLE");
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
