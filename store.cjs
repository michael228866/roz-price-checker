const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { SERVER_ID, listingKey, listingVersion } = require("./market.cjs");
const { navigationCommand } = require("./shop_location.cjs");

function verifiedLocation(item) {
  const location = item.location;
  return location?.source === "shop_detail_response" &&
    location.confidence === "MATCHED_SHOP_DETAIL" && navigationCommand(location)
    ? location : null;
}

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
      CREATE TABLE IF NOT EXISTS listing_versions (
        key TEXT PRIMARY KEY, listing_key TEXT NOT NULL, server_id INTEGER NOT NULL,
        shop TEXT NOT NULL, item_name TEXT NOT NULL, specification TEXT NOT NULL,
        price INTEGER NOT NULL, quantity INTEGER NOT NULL, spec_complete INTEGER NOT NULL,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS listing_versions_latest ON listing_versions(listing_key, last_seen);
      CREATE TABLE IF NOT EXISTS version_snapshots (
        run_id INTEGER NOT NULL REFERENCES scan_runs(id), version_key TEXT NOT NULL REFERENCES listing_versions(key),
        observed_at TEXT NOT NULL, PRIMARY KEY (run_id, version_key)
      );
      CREATE TABLE IF NOT EXISTS search_keywords (
        name TEXT PRIMARY KEY, tier TEXT NOT NULL, last_attempt_at TEXT,
        last_success_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS active_listing_refs (
        keyword TEXT NOT NULL, listing_key TEXT NOT NULL, version_key TEXT NOT NULL,
        expires_at TEXT NOT NULL, PRIMARY KEY (keyword, listing_key)
      );
      CREATE INDEX IF NOT EXISTS active_listing_refs_expiry ON active_listing_refs(expires_at);
      CREATE TABLE IF NOT EXISTS sale_transactions (
        id TEXT PRIMARY KEY, server_id INTEGER NOT NULL, specification TEXT NOT NULL,
        price INTEGER NOT NULL, quantity INTEGER NOT NULL, sold_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(price_alerts)").all().map((column) => column.name);
    if (!columns.includes("next_attempt_at")) {
      this.db.exec("ALTER TABLE price_alerts ADD COLUMN next_attempt_at TEXT");
    }
    if (!columns.includes("sample_count")) {
      this.db.exec("ALTER TABLE price_alerts ADD COLUMN sample_count INTEGER");
    }
    for (const table of ["listings", "price_alerts"]) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all()
        .map((column) => column.name));
      for (const [name, type] of [["location_map", "TEXT"], ["location_x", "INTEGER"],
        ["location_y", "INTEGER"], ["location_source", "TEXT"],
        ["location_confidence", "TEXT"]]) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }

  importCatalog(items, source = "csv") {
    const statement = this.db.prepare(`INSERT INTO catalog (name, tier, source, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET tier=excluded.tier,
      source=excluded.source, updated_at=excluded.updated_at`);
    const schedule = this.db.prepare(`INSERT INTO search_keywords (name, tier) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET tier=excluded.tier`);
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        statement.run(item.name, item.tier, source, new Date().toISOString());
        schedule.run(item.name, item.tier);
      }
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

  dueCatalog(limit = 20, now = new Date()) {
    const cutoffs = [5, 15, 60].map((minutes) => new Date(now.getTime() - minutes * 60000).toISOString());
    const due = this.db.prepare(`SELECT name, tier FROM search_keywords WHERE
      last_attempt_at IS NULL OR (tier='P0' AND last_attempt_at <= ?) OR
      (tier='P1' AND last_attempt_at <= ?) OR (tier='P2' AND last_attempt_at <= ?)
      ORDER BY COALESCE(last_attempt_at, ''), name`).all(...cutoffs);
    const queues = { P0: [], P1: [], P2: [] };
    for (const item of due) queues[item.tier]?.push(item);
    const result = [];
    const cycle = ["P0", "P0", "P1", "P0", "P1", "P2"];
    while (result.length < limit && cycle.some((tier) => queues[tier].length)) {
      for (const tier of cycle) {
        if (queues[tier].length && result.length < limit) result.push(queues[tier].shift());
      }
    }
    return result;
  }

  markKeyword(name, succeeded, at = new Date().toISOString()) {
    this.db.prepare(`UPDATE search_keywords SET last_attempt_at=?, attempts=attempts+1,
      last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END WHERE name=?`)
      .run(at, succeeded ? 1 : 0, at, name);
  }

  historicalReferences(maxAgeHours = 72, now = new Date()) {
    const cutoff = new Date(now.getTime() - maxAgeHours * 3600000).toISOString();
    const rows = this.db.prepare(`SELECT * FROM listing_versions WHERE last_seen >= ?
      AND server_id=? AND spec_complete=1 ORDER BY last_seen DESC`).all(cutoff, SERVER_ID);
    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.listing_key)) return false;
      seen.add(row.listing_key);
      return true;
    }).map((row) => ({ serverId: row.server_id, shop: row.shop,
      itemName: row.item_name, specification: row.specification,
      price: row.price, quantity: row.quantity, specComplete: true,
      storeType: "販售", marketKind: "ASK_HISTORY" }));
  }

  activeReferences(now = new Date()) {
    return this.db.prepare(`SELECT v.* FROM active_listing_refs a
      JOIN listing_versions v ON v.key=a.version_key
      WHERE a.expires_at > ? AND v.server_id=? AND v.spec_complete=1
      ORDER BY v.last_seen DESC`).all(now.toISOString(), SERVER_ID)
      .filter((row, index, rows) => rows.findIndex((other) =>
        other.listing_key === row.listing_key) === index)
      .map((row) => ({ serverId: row.server_id, shop: row.shop,
        itemName: row.item_name, specification: row.specification,
        price: row.price, quantity: row.quantity, specComplete: true,
        storeType: "販售", marketKind: "ACTIVE_ASK", observationKey: row.listing_key }));
  }

  transactionReferences() {
    return this.db.prepare(`SELECT server_id AS serverId, specification, price,
      quantity, sold_at AS soldAt, source FROM sale_transactions WHERE server_id=?`)
      .all(SERVER_ID).map((row) => ({ ...row, marketKind: "SALE_HISTORY" }));
  }

  unseenCandidates(analyses, maxAlertRatio = 0.15) {
    const exists = this.db.prepare("SELECT 1 FROM price_alerts WHERE key=?");
    return analyses.filter((item) => {
      if (item.serverId !== SERVER_ID || item.confidence === "INSUFFICIENT" ||
          item.sampleCount < 3 || item.anomalyType === "NORMAL" ||
          item.ratio > maxAlertRatio) return false;
      return !exists.get(`${listingVersion(item)}:${item.anomalyType}`);
    });
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

  saveObservations(runId, items, analyses, { maxAlertRatio = 0.15,
    scannedKeywords = [] } = {}) {
    if ([...items, ...analyses].some((item) => item.serverId !== SERVER_ID)) {
      throw new Error(`只允許 Server ID ${SERVER_ID}`);
    }
    const now = new Date().toISOString();
    const upsert = this.db.prepare(`INSERT INTO listings
      (key, server_id, shop, item_name, specification, price, quantity, spec_complete, first_seen, last_seen,
       location_map, location_x, location_y, location_source, location_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET price=excluded.price, quantity=excluded.quantity,
      spec_complete=excluded.spec_complete, last_seen=excluded.last_seen,
      location_map=excluded.location_map, location_x=excluded.location_x,
      location_y=excluded.location_y, location_source=excluded.location_source,
      location_confidence=excluded.location_confidence`);
    const version = this.db.prepare(`INSERT INTO listing_versions
      (key, listing_key, server_id, shop, item_name, specification, price, quantity,
       spec_complete, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_seen=excluded.last_seen`);
    const versionSnapshot = this.db.prepare(`INSERT OR IGNORE INTO version_snapshots
      (run_id, version_key, observed_at) VALUES (?, ?, ?)`);
    const snapshot = this.db.prepare("INSERT OR IGNORE INTO listing_snapshots (run_id, listing_key, observed_at) VALUES (?, ?, ?)");
    const baseline = this.db.prepare(`INSERT OR REPLACE INTO market_baselines
      (run_id, listing_key, reference_price, sample_count, confidence) VALUES (?, ?, ?, ?, ?)`);
    const alert = this.db.prepare(`INSERT OR IGNORE INTO price_alerts
      (key, listing_key, type, price, reference_price, confidence, created_at,
       location_map, location_x, location_y, location_source, location_confidence,
       sample_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const removeActive = this.db.prepare("DELETE FROM active_listing_refs WHERE keyword=?");
    const active = this.db.prepare(`INSERT OR REPLACE INTO active_listing_refs
      (keyword, listing_key, version_key, expires_at) VALUES (?, ?, ?, ?)`);
    const fresh = [];
    this.db.exec("BEGIN");
    try {
      for (const keyword of scannedKeywords) removeActive.run(keyword);
      for (const item of items) {
        const key = listingKey(item);
        const location = verifiedLocation(item);
        upsert.run(key, item.serverId, item.shop, item.itemName, item.specification,
          item.price, item.quantity, item.specComplete ? 1 : 0, now, now,
          location?.mapName ?? null, location?.x ?? null, location?.y ?? null,
          location?.source ?? null, location?.confidence ?? null);
        snapshot.run(runId, key, now);
        const versionKey = listingVersion(item);
        version.run(versionKey, key, item.serverId, item.shop, item.itemName,
          item.specification, item.price, item.quantity, item.specComplete ? 1 : 0, now, now);
        versionSnapshot.run(runId, versionKey, now);
        if (scannedKeywords.includes(item.keyword) && item.specComplete) {
          active.run(item.keyword, key, versionKey,
            new Date(Date.now() + 15 * 60000).toISOString());
        }
      }
      for (const item of analyses) {
        const key = listingKey(item);
        baseline.run(runId, key, item.referencePrice, item.sampleCount, item.confidence);
        if (item.confidence === "INSUFFICIENT" || item.sampleCount < 3 ||
            item.anomalyType === "NORMAL" || item.ratio > maxAlertRatio) continue;
        const location = verifiedLocation(item);
        const alertKey = `${listingVersion(item)}:${item.anomalyType}`;
        if (alert.run(alertKey, key, item.anomalyType, item.price, item.referencePrice,
          item.confidence, now, location?.mapName ?? null, location?.x ?? null,
          location?.y ?? null, location?.source ?? null,
          location?.confidence ?? null, item.sampleCount).changes) {
          fresh.push({ ...item, location, alertKey });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return fresh;
  }

  saveVisibleAlerts(items) {
    if (items.some((item) => item.serverId !== SERVER_ID)) {
      throw new Error(`只允許 Server ID ${SERVER_ID}`);
    }
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
      a.confidence, a.sample_count AS sampleCount, a.attempts,
      l.item_name AS itemName, l.shop,
      a.location_map AS mapName, a.location_x AS x, a.location_y AS y,
      a.location_source AS locationSource, a.location_confidence AS locationConfidence
      FROM price_alerts a JOIN listings l ON l.key=a.listing_key
      WHERE l.server_id=? AND a.delivery_status='pending' AND a.attempts < 3 AND
      (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)
      ORDER BY a.created_at LIMIT ?`).all(SERVER_ID, new Date().toISOString(), limit);
  }

  markDelivery(key, status, error = null, nextAttemptAt = null, countAttempt = true) {
    this.db.prepare(`UPDATE price_alerts SET delivery_status=?, attempts=attempts+?,
      last_error=?, next_attempt_at=? WHERE key=?`)
      .run(status, countAttempt ? 1 : 0, error, nextAttemptAt, key);
  }

  status() {
    return {
      catalog: this.db.prepare("SELECT COUNT(*) AS count FROM catalog").get().count,
      listings: this.db.prepare("SELECT COUNT(*) AS count FROM listings WHERE server_id=?")
        .get(SERVER_ID).count,
      pendingAlerts: this.db.prepare(`SELECT COUNT(*) AS count FROM price_alerts a
        JOIN listings l ON l.key=a.listing_key WHERE l.server_id=?
        AND a.delivery_status='pending'`).get(SERVER_ID).count,
      coverage: this.db.prepare(`SELECT COUNT(*) AS known,
        SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned
        FROM search_keywords`).get(),
      lastRun: this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() ?? null,
      lastCompletedRun: this.db.prepare(`SELECT finished_at, status, listings_parsed
        FROM scan_runs WHERE finished_at IS NOT NULL AND status IN ('COMPLETE', 'PARTIAL')
        ORDER BY id DESC LIMIT 1`).get() ?? null
    };
  }

  close() { this.db.close(); }
}

module.exports = { MarketStore };
