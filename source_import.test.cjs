const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MarketStore } = require("./store.cjs");
const { MarketRepository } = require("./market_repository.cjs");
const { AuthorizedFileAdapter, OfficialApiAdapter, MockOfficialApiAdapter } = require("./source_import.cjs");

const base = { serverId: 529, itemName: "魔靈石", shop: "甲店", price: 100,
  quantity: 1, storeType: "販售", itemRefining: 0, ItemGradeLevel: 0,
  DefaultSlotCount: 0, slot_1: "0", slot_2: "0", slot_3: "0", slot_4: "0",
  RandomOpt1: "0", RandomOpt2: "0", RandomOpt3: "0", RandomOpt4: "0", RandomOpt5: "0",
  mapName: "prontera", xPos: 100, yPos: 100, observedAt: "2026-10-15T00:00:00Z",
  sourceListingId: "one", sourceId: "user-file" };

test("authorized JSON and CSV imports preserve provenance, reject bad rows and deduplicate files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-import-"));
  const filename = path.join(directory, "market.sqlite");
  const store = new MarketStore(filename);
  try {
    const adapter = new AuthorizedFileAdapter("user-file", "user-owned export");
    const json = JSON.stringify([base, { ...base, serverId: 1, sourceListingId: "bad" }]);
    const batch = adapter.fetchOrImport(json, "json");
    assert.equal(batch.valid.length, 1);
    assert.equal(batch.errors.length, 1);
    assert.equal(store.importSourceObservations(adapter, batch).inserted, 1);
    assert.equal(store.importSourceObservations(adapter, batch).duplicate, true);
    const csv = Object.keys(base).join(",") + "\n" + Object.values({ ...base,
      sourceListingId: "two", price: 90 }).join(",") + "\n";
    assert.equal(store.importSourceObservations(adapter,
      adapter.fetchOrImport(csv, "csv")).inserted, 1);
    const repository = new MarketRepository(store);
    const items = repository.items(new URLSearchParams("q=魔靈石"));
    assert.equal(items.total, 1);
    const listings = repository.listings(items.items[0].id, new URLSearchParams());
    assert.equal(listings.total, 2);
    assert.ok(listings.items.every((item) => item.source === "user-file" &&
      !item.navigation && item.state !== "VERIFIED_ACTIVE_OBSERVATION"));
    assert.equal(repository.sources().find((source) => source.id === "official-api").enabled, 0);
    assert.throws(() => new OfficialApiAdapter().fetchOrImport(), /AUTHORIZATION_REQUIRED/);
    assert.equal(new MockOfficialApiAdapter([{ ...base,
      sourceId: "official-api" }]).fetchOrImport().length, 1);
    store.close();
    const reopened = new MarketStore(filename);
    assert.equal(new MarketRepository(reopened).items(new URLSearchParams()).total, 1);
    reopened.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("low imported asking price becomes watchlist without a Discord alert", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-watchlist-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const adapter = new AuthorizedFileAdapter("user-file", "user-owned export");
    const imported = adapter.fetchOrImport(JSON.stringify([{ ...base,
      observedAt: new Date().toISOString() }]), "json");
    const spec = imported.valid[0].specification;
    const runId = store.startRun();
    store.saveObservations(runId, [1, 2, 3].map((number) => ({
      serverId: 529, keyword: "魔靈石", itemName: "魔靈石", shop: `賣家${number}`,
      price: 1000, quantity: 1, storeType: "販售", specification: spec,
      specComplete: true, ssi: `seller-${number}`
    })), [], { scannedKeywords: ["魔靈石"] });
    const report = store.importSourceObservations(adapter, imported);
    assert.equal(report.watchlist, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM price_watchlist").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM price_alerts").get().count, 0);
    assert.equal(store.db.prepare("SELECT records_inserted FROM sync_jobs").get().records_inserted, 1);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("older import cannot replace the latest asking price and malformed coordinates are rejected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-import-order-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const adapter = new AuthorizedFileAdapter("user-file", "user-owned export");
    const recent = adapter.fetchOrImport(JSON.stringify([{ ...base,
      observedAt: "2026-10-14T00:00:00Z", price: 200 }]), "json");
    store.importSourceObservations(adapter, recent);
    const old = adapter.fetchOrImport(JSON.stringify([{ ...base,
      observedAt: "2026-10-13T00:00:00Z", price: 100 }]), "json");
    store.importSourceObservations(adapter, old);
    assert.equal(store.db.prepare("SELECT price FROM listings WHERE key=?")
      .get(recent.valid[0].listingKey).price, 200);
    const bad = adapter.fetchOrImport(JSON.stringify([{ ...base, xPos: "wrong" }]), "json");
    assert.equal(bad.valid.length, 0);
    assert.equal(bad.errors.length, 1);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("two authorized sources share only an explicitly identified listing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-cross-source-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    for (const sourceId of ["source-a", "source-b"]) {
      const adapter = new AuthorizedFileAdapter(sourceId, "licensed export");
      const batch = adapter.fetchOrImport(JSON.stringify([{ ...base, sourceId,
        canonicalListingId: "shared-123" }]), "json");
      store.importSourceObservations(adapter, batch);
    }
    const repository = new MarketRepository(store);
    const item = repository.items(new URLSearchParams("q=魔靈石")).items[0];
    const listings = repository.listings(item.id, new URLSearchParams());
    assert.equal(listings.total, 1);
    assert.deepEqual(listings.items[0].sources.sort(), ["source-a", "source-b"]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM source_observations").get().count, 2);
    assert.equal(repository.history(item.id, "30d").asks[0].samples, 1);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("same item name with different refine and card specifications remains separate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-specs-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  try {
    const adapter = new AuthorizedFileAdapter("user-file", "licensed export");
    const batch = adapter.fetchOrImport(JSON.stringify([base, { ...base,
      sourceListingId: "refined", itemRefining: 7, slot_1: "卡片 A" }]), "json");
    store.importSourceObservations(adapter, batch);
    const items = new MarketRepository(store).items(new URLSearchParams("q=魔靈石"));
    assert.equal(items.total, 2);
    assert.notEqual(items.items[0].id, items.items[1].id);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
