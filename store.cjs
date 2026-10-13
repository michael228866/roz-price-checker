const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { listingKey } = require("./market.cjs");

class MarketStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (
        name TEXT PRIMARY KEY, tier TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, keywords_attempted INTEGER NOT NULL DEFAULT 0,
        keywords_succeeded INTEGER NOT NULL DEFAULT 0, listings_parsed INTEGER NOT NULL DEFAULT 0,
        pagination_status TEXT NOT NULL DEFAULT 'PAGINATION_UNVERIFIED', error TEXT
      );
      CREATE TABLE IF NOT EXISTS listings (
        key TEXT PRIMARY KEY, server_id INTEGER NOT NULL, shop TEXT NOT NULL,
        item_name TEXT NOT NULL, specification TEXT NOT NULL, price INTEGER NOT NULL,
        quantity INTEGER NOT NULL, spec_complete INTEGER NOT NULL,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS listings_specification ON listings(specification);
      CREATE TABLE IF NOT EXISTS listing_snapshots (
        run_id INTEGER NOT NULL REFERENCES scan_runs(id), listing_key TEXT NOT NULL REFERENCES listings(key),
        observed_at TEXT NOT NULL, PRIMARY KEY (run_id, listing_key)
      );
      CREATE TABLE IF NOT EXISTS market_baselines (
        run_id INTEGER NOT NULL REFERENCES scan_runs(id), listing_key TEXT NOT NULL REFERENCES listings(key),
        reference_price REAL NOT NULL, sample_count INTEGER NOT NULL, confidence TEXT NOT NULL,
        PRIMARY KEY (run_id, listing_key)
      );
      CREATE TABLE IF NOT EXISTS price_alerts (
        key TEXT PRIMARY KEY, listing_key TEXT NOT NULL REFERENCES listings(key),
        type TEXT NOT NULL, price INTEGER NOT NULL, reference_price REAL NOT NULL,
        confidence TEXT NOT NULL, created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
  }

  importCatalog(items, source = "csv") {
    const statement = this.db.prepare(`INSERT INTO catalog (name, tier, source, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET tier=excluded.tier,
      source=excluded.source, updated_at=excluded.updated_at`);
    this.db.exec("BEGIN");
    try {
      for (const item of items) statement.run(item.name, item.tier, source, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return items.length;
  }

  catalog(limit = 20, offset = 0) {
    return this.db.prepare("SELECT name, tier FROM catalog ORDER BY tier, name LIMIT ? OFFSET ?").all(limit, offset);
  }

  startRun() {
    return Number(this.db.prepare("INSERT INTO scan_runs (started_at, status) VALUES (?, 'RUNNING')")
      .run(new Date().toISOString()).lastInsertRowid);
  }

  finishRun(id, status, metrics = {}, error = null) {
    this.db.prepare(`UPDATE scan_runs SET finished_at=?, status=?, keywords_attempted=?,
      keywords_succeeded=?, listings_parsed=?, pagination_status=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), status, metrics.attempted ?? 0, metrics.succeeded ?? 0,
        metrics.listings ?? 0, metrics.paginationStatus ?? "PAGINATION_UNVERIFIED", error, id);
  }

  saveObservations(runId, items, analyses) {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(`INSERT INTO listings
      (key, server_id, shop, item_name, specification, price, quantity, spec_complete, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_seen=excluded.last_seen`);
    const snapshot = this.db.prepare("INSERT OR IGNORE INTO listing_snapshots (run_id, listing_key, observed_at) VALUES (?, ?, ?)");
    const baseline = this.db.prepare(`INSERT OR REPLACE INTO market_baselines
      (run_id, listing_key, reference_price, sample_count, confidence) VALUES (?, ?, ?, ?, ?)`);
    const alert = this.db.prepare(`INSERT OR IGNORE INTO price_alerts
      (key, listing_key, type, price, reference_price, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const fresh = [];
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const key = listingKey(item);
        upsert.run(key, item.serverId, item.shop, item.itemName, item.specification,
          item.price, item.quantity, item.specComplete ? 1 : 0, now, now);
        snapshot.run(runId, key, now);
      }
      for (const item of analyses) {
        const key = listingKey(item);
        baseline.run(runId, key, item.referencePrice, item.sampleCount, item.confidence);
        if (item.confidence === "INSUFFICIENT" || item.sampleCount < 3 || item.anomalyType === "NORMAL") continue;
        const alertKey = `${key}:${item.anomalyType}`;
        if (alert.run(alertKey, key, item.anomalyType, item.price, item.referencePrice,
          item.confidence, now).changes) fresh.push({ ...item, alertKey });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return fresh;
  }

  saveVisibleAlerts(items) {
    const statement = this.db.prepare(`INSERT OR IGNORE INTO price_alerts
      (key, listing_key, type, price, reference_price, confidence, created_at)
      VALUES (?, ?, 'VISIBLE_PAGE_LOW_PRICE', ?, ?, 'LOW', ?)`);
    const fresh = [];
    for (const item of items) {
      const key = listingKey(item);
      const alertKey = `${key}:VISIBLE_PAGE_LOW_PRICE`;
      if (statement.run(alertKey, key, item.price, item.referencePrice, new Date().toISOString()).changes) {
        fresh.push({ ...item, alertKey });
      }
    }
    return fresh;
  }

  pendingAlerts(limit = 20) {
    return this.db.prepare(`SELECT a.key, a.type, a.price, a.reference_price AS referencePrice,
      a.confidence, a.attempts, l.item_name AS itemName, l.shop
      FROM price_alerts a JOIN listings l ON l.key=a.listing_key
      WHERE a.delivery_status='pending' AND a.attempts < 3 ORDER BY a.created_at LIMIT ?`).all(limit);
  }

  markDelivery(key, status, error = null) {
    this.db.prepare("UPDATE price_alerts SET delivery_status=?, attempts=attempts+1, last_error=? WHERE key=?")
      .run(status, error, key);
  }

  status() {
    return {
      catalog: this.db.prepare("SELECT COUNT(*) AS count FROM catalog").get().count,
      listings: this.db.prepare("SELECT COUNT(*) AS count FROM listings").get().count,
      pendingAlerts: this.db.prepare("SELECT COUNT(*) AS count FROM price_alerts WHERE delivery_status='pending'").get().count,
      lastRun: this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() ?? null
    };
  }

  close() { this.db.close(); }
}

module.exports = { MarketStore };
