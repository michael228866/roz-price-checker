const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
      CREATE TABLE IF NOT EXISTS scan_keyword_pages (
        run_id INTEGER NOT NULL REFERENCES scan_runs(id), keyword TEXT NOT NULL,
        status TEXT NOT NULL, observed_count INTEGER NOT NULL,
        reported_count INTEGER, page_count INTEGER NOT NULL,
        verification TEXT NOT NULL, PRIMARY KEY (run_id, keyword)
      );
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
    if (!columns.includes("location_status")) {
      this.db.exec("ALTER TABLE price_alerts ADD COLUMN location_status TEXT");
    }
    const runColumns = new Set(this.db.prepare("PRAGMA table_info(scan_runs)").all()
      .map((column) => column.name));
    if (!runColumns.has("last_search_at")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN last_search_at TEXT");
    }
    if (!runColumns.has("last_keyword")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN last_keyword TEXT");
    }
    const versionSnapshotColumns = new Set(this.db.prepare("PRAGMA table_info(version_snapshots)")
      .all().map((column) => column.name));
    if (!versionSnapshotColumns.has("observation_quality")) {
      this.db.exec("ALTER TABLE version_snapshots ADD COLUMN observation_quality TEXT");
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
    this.db.exec("BEGIN");
    try {
      const alertColumns = new Set(this.db.prepare("PRAGMA table_info(price_alerts)").all()
        .map((column) => column.name));
      if (!alertColumns.has("updated_at")) {
        this.db.exec("ALTER TABLE price_alerts ADD COLUMN updated_at TEXT");
        this.db.exec("UPDATE price_alerts SET updated_at=created_at WHERE updated_at IS NULL");
      }
      for (const table of ["listings", "listing_versions"]) {
        const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all()
          .map((column) => column.name));
        if (!columns.has("specification_json")) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN specification_json TEXT`);
        }
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS data_sources (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN
            ('AUTHORIZED_API', 'AUTHORIZED_IMPORT', 'PERMITTED_UI_OBSERVATION', 'LOCAL_ARCHIVE')),
          authorization_status TEXT NOT NULL, authorization_reference TEXT,
          enabled INTEGER NOT NULL DEFAULT 0, supports_incremental_sync INTEGER NOT NULL DEFAULT 0,
          last_success_at TEXT, last_error TEXT);
        CREATE TABLE IF NOT EXISTS sync_jobs (
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id),
          started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
          records_received INTEGER NOT NULL DEFAULT 0, records_valid INTEGER NOT NULL DEFAULT 0,
          records_rejected INTEGER NOT NULL DEFAULT 0, records_inserted INTEGER NOT NULL DEFAULT 0,
          records_updated INTEGER NOT NULL DEFAULT 0, error_category TEXT);
        CREATE TABLE IF NOT EXISTS import_batches (
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id),
          file_hash TEXT NOT NULL, imported_at TEXT NOT NULL, status TEXT NOT NULL,
          record_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL,
          UNIQUE(source_id, file_hash));
        CREATE TABLE IF NOT EXISTS source_observations (
          observation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id),
          source_listing_id TEXT, listing_key TEXT, version_key TEXT, server_id INTEGER NOT NULL,
          observed_at TEXT NOT NULL, imported_at TEXT NOT NULL,
          observation_quality TEXT NOT NULL, source_batch_id INTEGER REFERENCES import_batches(id),
          verification_status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS price_watchlist (
          key TEXT PRIMARY KEY, listing_key TEXT NOT NULL, source_id TEXT NOT NULL,
          price INTEGER NOT NULL, reference_price REAL NOT NULL,
          sample_count INTEGER NOT NULL, confidence TEXT NOT NULL,
          reason TEXT NOT NULL, observed_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'WATCHLIST');
        CREATE INDEX IF NOT EXISTS listings_item_price ON listings(server_id, item_name, price, key);
        CREATE INDEX IF NOT EXISTS version_snapshots_observed ON version_snapshots(observed_at, version_key);
        CREATE INDEX IF NOT EXISTS source_observations_listing ON source_observations(listing_key, observed_at);
      `);
      const watchColumns = new Set(this.db.prepare("PRAGMA table_info(price_watchlist)").all()
        .map((column) => column.name));
      if (!watchColumns.has("status")) {
        this.db.exec("ALTER TABLE price_watchlist ADD COLUMN status TEXT NOT NULL DEFAULT 'WATCHLIST'");
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (1, ?)")
        .run(new Date().toISOString());
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (2, ?)")
        .run(new Date().toISOString());
      this.db.prepare(`INSERT OR IGNORE INTO data_sources
        (id, name, source_type, authorization_status, enabled)
        VALUES ('gnjoy-ui', 'GNJOY 查詢頁', 'PERMITTED_UI_OBSERVATION', 'USER_CONTROLLED', 0),
          ('authorized-file', '授權檔案匯入', 'AUTHORIZED_IMPORT', 'AUTHORIZATION_REQUIRED', 0),
          ('official-api', '官方 API', 'AUTHORIZED_API', 'AUTHORIZATION_REQUIRED', 0)`)
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  importSourceObservations(adapter, batch, maxRatio = 0.15) {
    adapter.validateConfiguration();
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO data_sources (id, name, source_type,
        authorization_status, authorization_reference, enabled)
        VALUES (?, ?, 'AUTHORIZED_IMPORT', 'AUTHORIZED_BY_USER', ?, 0)
        ON CONFLICT(id) DO UPDATE SET authorization_status='AUTHORIZED_BY_USER',
        authorization_reference=excluded.authorization_reference, last_error=NULL`)
        .run(adapter.sourceId, adapter.sourceId, adapter.authorizationReference);
      const existing = this.db.prepare("SELECT id FROM import_batches WHERE source_id=? AND file_hash=?")
        .get(adapter.sourceId, batch.fileHash);
      if (existing) {
        this.db.exec("COMMIT");
        return { duplicate: true, inserted: 0, rejected: batch.errors.length,
          errors: batch.errors, batchId: existing.id };
      }
      const batchId = Number(this.db.prepare(`INSERT INTO import_batches
        (source_id, file_hash, imported_at, status, record_count, rejected_count)
        VALUES (?, ?, ?, ?, ?, ?)`).run(adapter.sourceId, batch.fileHash,
        now, batch.errors.length ? "PARTIAL" : "COMPLETE",
        batch.received, batch.errors.length).lastInsertRowid);
      const listing = this.db.prepare(`INSERT INTO listings
        (key, server_id, shop, item_name, specification, price, quantity, spec_complete,
         first_seen, last_seen, specification_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
        price=CASE WHEN excluded.last_seen>listings.last_seen THEN excluded.price ELSE listings.price END,
        quantity=CASE WHEN excluded.last_seen>listings.last_seen THEN excluded.quantity ELSE listings.quantity END,
        last_seen=MAX(listings.last_seen, excluded.last_seen),
        specification_json=COALESCE(excluded.specification_json, listings.specification_json)`);
      const version = this.db.prepare(`INSERT INTO listing_versions
        (key, listing_key, server_id, shop, item_name, specification, price, quantity,
         spec_complete, first_seen, last_seen, specification_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen)`);
      const observation = this.db.prepare(`INSERT OR IGNORE INTO source_observations
        (observation_id, source_id, source_listing_id, listing_key, version_key,
         server_id, observed_at, imported_at, observation_quality,
         source_batch_id, verification_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNVERIFIED_IMPORT')`);
      let inserted = 0;
      for (const item of batch.valid) {
        listing.run(item.listingKey, item.serverId, item.shop, item.itemName,
          item.specification, item.price, item.quantity, item.specComplete ? 1 : 0,
          item.observedAt, item.observedAt, item.specificationJson);
        version.run(item.versionKey, item.listingKey, item.serverId, item.shop,
          item.itemName, item.specification, item.price, item.quantity,
          item.specComplete ? 1 : 0, item.observedAt, item.observedAt,
          item.specificationJson);
        const observationId = crypto.createHash("sha256")
          .update(JSON.stringify([adapter.sourceId, item.sourceListingId,
            item.observedAt, item.versionKey])).digest("hex");
        inserted += Number(observation.run(observationId, adapter.sourceId,
          item.sourceListingId, item.listingKey, item.versionKey, item.serverId,
          item.observedAt, now, item.specComplete ? "COMPLETE_IMPORT" : "INCOMPLETE_IMPORT",
          batchId).changes);
      }
      this.db.prepare("UPDATE data_sources SET last_success_at=?, last_error=NULL WHERE id=?")
        .run(now, adapter.sourceId);
      const watchlist = this.recordWatchlist(batch.valid, adapter.sourceId, maxRatio);
      this.db.prepare(`INSERT INTO sync_jobs
        (source_id, started_at, finished_at, status, records_received, records_valid,
         records_rejected, records_inserted, records_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(adapter.sourceId, now, new Date().toISOString(),
          batch.errors.length ? "PARTIAL" : "COMPLETE", batch.received,
          batch.valid.length, batch.errors.length, inserted);
      this.db.exec("COMMIT");
      return { duplicate: false, inserted, rejected: batch.errors.length,
        errors: batch.errors, batchId, watchlist };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordImportFailure(adapter, category) {
    adapter.validateConfiguration();
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO data_sources (id, name, source_type,
        authorization_status, authorization_reference, enabled, last_error)
        VALUES (?, ?, 'AUTHORIZED_IMPORT', 'AUTHORIZED_BY_USER', ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`)
        .run(adapter.sourceId, adapter.sourceId, adapter.authorizationReference, category);
      this.db.prepare(`INSERT INTO sync_jobs
        (source_id, started_at, finished_at, status, error_category)
        VALUES (?, ?, ?, 'FAILED', ?)`).run(adapter.sourceId, now, now, category);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recordWatchlist(items, sourceId, maxRatio = 0.15) {
    const stale = this.db.prepare(`UPDATE price_watchlist SET status='STALE'
      WHERE listing_key=? AND price<>? AND status='WATCHLIST'`);
    for (const item of items) stale.run(listingKey(item), item.price);
    const groups = new Map();
    for (const ref of this.activeReferences()) {
      const sellers = groups.get(ref.specification) ?? new Map();
      const previous = sellers.get(ref.shop);
      if (previous === undefined || ref.price < previous) sellers.set(ref.shop, ref.price);
      groups.set(ref.specification, sellers);
    }
    const references = new Map([...groups].map(([specification, sellers]) => {
      const sorted = [...sellers].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      return [specification, { sorted, indices: new Map(sorted.map(([shop], index) => [shop, index])) }];
    }));
    const candidates = [];
    for (const item of items) {
      if (!item.specComplete || item.serverId !== SERVER_ID || item.storeType !== "販售") continue;
      const group = references.get(item.specification);
      if (!group) continue;
      const excluded = group.indices.get(item.shop);
      const count = group.sorted.length - (excluded === undefined ? 0 : 1);
      if (count < 1) continue;
      const at = (index) => group.sorted[index + (excluded !== undefined && index >= excluded ? 1 : 0)][1];
      const middle = Math.floor(count / 2);
      const referencePrice = count % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
      if (item.price / referencePrice > maxRatio) continue;
      candidates.push({ ...item, referencePrice, sampleCount: count,
        confidence: count >= 5 ? "HIGH" : count >= 3 ? "MEDIUM" : "LOW" });
    }
    const insert = this.db.prepare(`INSERT INTO price_watchlist
      (key, listing_key, source_id, price, reference_price, sample_count,
       confidence, reason, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET reference_price=excluded.reference_price,
      sample_count=excluded.sample_count, observed_at=excluded.observed_at`);
    for (const item of candidates) {
      insert.run(listingVersion(item), listingKey(item), sourceId,
        item.price, item.referencePrice, item.sampleCount, item.confidence,
        item.sampleCount < 3 ? "INSUFFICIENT_SAMPLES" : "AWAITING_VERIFICATION",
        item.observedAt ?? new Date().toISOString());
    }
    return candidates.length;
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
    const rows = this.db.prepare(`SELECT v.* FROM active_listing_refs a
      JOIN listing_versions v ON v.key=a.version_key
      WHERE a.expires_at > ? AND v.server_id=? AND v.spec_complete=1
      ORDER BY v.last_seen DESC`).all(now.toISOString(), SERVER_ID);
    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.listing_key)) return false;
      seen.add(row.listing_key);
      return true;
    })
      .map((row) => ({ serverId: row.server_id, shop: row.shop,
        itemName: row.item_name, specification: row.specification,
        price: row.price, quantity: row.quantity, specComplete: true,
        storeType: "販售", marketKind: "ACTIVE_ASK", observationKey: row.listing_key }));
  }

  recentReferences(maxAgeMinutes = 15, now = new Date()) {
    const cutoff = new Date(now.getTime() - maxAgeMinutes * 60000).toISOString();
    return this.db.prepare(`SELECT v.*, (SELECT s.observation_quality
      FROM version_snapshots s WHERE s.version_key=v.key
      ORDER BY s.run_id DESC LIMIT 1) AS observation_quality
      FROM listing_versions v
      WHERE v.last_seen >= ? AND v.server_id=? AND v.spec_complete=1
      AND NOT EXISTS (SELECT 1 FROM active_listing_refs a
        WHERE a.version_key=v.key AND a.expires_at > ?)
      ORDER BY v.last_seen DESC`).all(cutoff, SERVER_ID, now.toISOString())
      .map((row) => ({ serverId: row.server_id, shop: row.shop,
        itemName: row.item_name, specification: row.specification,
        price: row.price, quantity: row.quantity, specComplete: true,
        storeType: "販售", marketKind: "RECENT_ASK",
        observationQuality: row.observation_quality ?? "UNKNOWN_LEGACY" }));
  }

  markListingUnavailable(item) {
    const key = listingKey(item);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM active_listing_refs WHERE listing_key=?").run(key);
      this.db.prepare(`UPDATE price_alerts SET delivery_status='not_available',
        location_status='LISTING_UNAVAILABLE'
        WHERE listing_key=? AND delivery_status='location_pending'`).run(key);
      this.db.prepare("UPDATE price_watchlist SET status='UNAVAILABLE' WHERE listing_key=?")
        .run(key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transactionReferences() {
    return this.db.prepare(`SELECT server_id AS serverId, specification, price,
      quantity, sold_at AS soldAt, source FROM sale_transactions WHERE server_id=?`)
      .all(SERVER_ID).map((row) => ({ ...row, marketKind: "SALE_HISTORY" }));
  }

  unseenCandidates(analyses, maxAlertRatio = 0.15) {
    const exists = this.db.prepare("SELECT delivery_status FROM price_alerts WHERE key=?");
    return analyses.filter((item) => {
      if (item.serverId !== SERVER_ID || item.confidence === "INSUFFICIENT" ||
          item.sampleCount < 3 || item.anomalyType === "NORMAL" ||
          item.ratio > maxAlertRatio) return false;
      const alert = exists.get(`${listingVersion(item)}:${item.anomalyType}`);
      return !alert || alert.delivery_status === "location_pending";
    });
  }

  startRun() {
    return Number(this.db.prepare("INSERT INTO scan_runs (started_at, status) VALUES (?, 'RUNNING')")
      .run(new Date().toISOString()).lastInsertRowid);
  }

  recordKeywordPages(runId, keyword, page) {
    if (!["COMPLETE", "PARTIAL", "PAGINATION_UNVERIFIED"].includes(page.status) ||
        !Array.isArray(page.items)) throw new Error("關鍵字分頁紀錄無效");
    this.db.prepare(`INSERT INTO scan_keyword_pages (run_id, keyword, status,
      observed_count, reported_count, page_count, verification)
      VALUES (?, ?, ?, ?, ?, ?, 'SOURCE_VERIFIED_LIVE_UNVERIFIED')
      ON CONFLICT(run_id, keyword) DO UPDATE SET status=excluded.status,
      observed_count=excluded.observed_count, reported_count=excluded.reported_count,
      page_count=excluded.page_count, verification=excluded.verification`)
      .run(runId, keyword, page.status, page.items.length,
        page.reportedCount ?? null, page.pageCount ?? 1);
  }

  markSearchAttempt(runId, keyword) {
    this.db.prepare("UPDATE scan_runs SET last_search_at=?, last_keyword=? WHERE id=?")
      .run(new Date().toISOString(), keyword, runId);
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
       location_map, location_x, location_y, location_source, location_confidence,
       specification_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET price=excluded.price, quantity=excluded.quantity,
      spec_complete=excluded.spec_complete, last_seen=excluded.last_seen,
      location_map=excluded.location_map, location_x=excluded.location_x,
      location_y=excluded.location_y, location_source=excluded.location_source,
      location_confidence=excluded.location_confidence,
      specification_json=COALESCE(excluded.specification_json, specification_json)`);
    const version = this.db.prepare(`INSERT INTO listing_versions
      (key, listing_key, server_id, shop, item_name, specification, price, quantity,
       spec_complete, first_seen, last_seen, specification_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_seen=excluded.last_seen`);
    const versionSnapshot = this.db.prepare(`INSERT INTO version_snapshots
      (run_id, version_key, observed_at, observation_quality) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, version_key) DO UPDATE SET
      observation_quality=CASE WHEN observation_quality='COMPLETE_PAGESET'
        THEN observation_quality ELSE excluded.observation_quality END`);
    const sourceObservation = this.db.prepare(`INSERT OR IGNORE INTO source_observations
      (observation_id, source_id, source_listing_id, listing_key, version_key,
       server_id, observed_at, imported_at, observation_quality, verification_status)
       VALUES (?, 'gnjoy-ui', ?, ?, ?, ?, ?, ?, ?, 'UI_OBSERVED')`);
    const snapshot = this.db.prepare("INSERT OR IGNORE INTO listing_snapshots (run_id, listing_key, observed_at) VALUES (?, ?, ?)");
    const baseline = this.db.prepare(`INSERT OR REPLACE INTO market_baselines
      (run_id, listing_key, reference_price, sample_count, confidence) VALUES (?, ?, ?, ?, ?)`);
    const alert = this.db.prepare(`INSERT OR IGNORE INTO price_alerts
      (key, listing_key, type, price, reference_price, confidence, created_at,
       location_map, location_x, location_y, location_source, location_confidence,
       sample_count, delivery_status, location_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const resolveLocation = this.db.prepare(`UPDATE price_alerts SET location_map=?,
      location_x=?, location_y=?, location_source=?, location_confidence=?,
      delivery_status=CASE WHEN delivery_status='location_pending' THEN 'pending'
        ELSE delivery_status END, location_status='VERIFIED', updated_at=?
      WHERE key=? AND COALESCE(location_status, '')<>'VERIFIED'`);
    const removeActive = this.db.prepare("DELETE FROM active_listing_refs WHERE keyword=?");
    const active = this.db.prepare(`INSERT OR REPLACE INTO active_listing_refs
      (keyword, listing_key, version_key, expires_at) VALUES (?, ?, ?, ?)`);
    const revokeOlderVersion = this.db.prepare(`DELETE FROM active_listing_refs
      WHERE listing_key=? AND version_key<>?`);
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
          location?.source ?? null, location?.confidence ?? null,
          item.specificationJson ?? null);
        snapshot.run(runId, key, now);
        const versionKey = listingVersion(item);
        version.run(versionKey, key, item.serverId, item.shop, item.itemName,
          item.specification, item.price, item.quantity, item.specComplete ? 1 : 0,
          now, now, item.specificationJson ?? null);
        versionSnapshot.run(runId, versionKey, now,
          scannedKeywords.includes(item.keyword) ? "COMPLETE_PAGESET" : "PARTIAL_PAGESET");
        sourceObservation.run(crypto.createHash("sha256")
          .update(JSON.stringify([runId, key, versionKey])).digest("hex"),
        item.ssi ?? null, key, versionKey, item.serverId, now, now,
        scannedKeywords.includes(item.keyword) ? "COMPLETE_PAGESET" : "PARTIAL_PAGESET");
        revokeOlderVersion.run(key, versionKey);
        if (scannedKeywords.includes(item.keyword) && item.specComplete) {
          active.run(item.keyword, key, versionKey,
            new Date(Date.now() + 15 * 60000).toISOString());
        }
      }
      if (scannedKeywords.length) {
        this.db.prepare("UPDATE data_sources SET last_success_at=? WHERE id='gnjoy-ui'")
          .run(now);
      }
      for (const item of analyses) {
        const key = listingKey(item);
        baseline.run(runId, key, item.referencePrice, item.sampleCount, item.confidence);
        if (item.confidence === "INSUFFICIENT" || item.sampleCount < 3 ||
            item.anomalyType === "NORMAL" || item.ratio > maxAlertRatio) continue;
        const location = verifiedLocation(item);
        const alertKey = `${listingVersion(item)}:${item.anomalyType}`;
        if (location) resolveLocation.run(location.mapName, location.x, location.y,
          location.source, location.confidence, now, alertKey);
        if (alert.run(alertKey, key, item.anomalyType, item.price, item.referencePrice,
          item.confidence, now, location?.mapName ?? null, location?.x ?? null,
          location?.y ?? null, location?.source ?? null,
          location?.confidence ?? null, item.sampleCount,
          location ? "pending" : "location_pending",
          location ? "VERIFIED" : "LOCATION_PENDING", now).changes) {
          fresh.push({ ...item, location, alertKey });
        }
        this.db.prepare(`UPDATE price_watchlist SET status='CONFIRMED'
          WHERE listing_key=? AND price=?`).run(key, item.price);
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
      (key, listing_key, type, price, reference_price, confidence, created_at, updated_at)
      VALUES (?, ?, 'VISIBLE_PAGE_LOW_PRICE', ?, ?, 'LOW', ?, ?)`);
    const fresh = [];
    for (const item of items) {
      const key = listingKey(item);
      const alertKey = `${key}:VISIBLE_PAGE_LOW_PRICE`;
      const now = new Date().toISOString();
      if (statement.run(alertKey, key, item.price, item.referencePrice, now, now).changes) {
        fresh.push({ ...item, alertKey });
      }
    }
    return fresh;
  }

  pendingAlerts(limit = 20) {
    this.db.prepare(`UPDATE price_alerts SET delivery_status='pending',
      location_status='UNAVAILABLE', updated_at=?
      WHERE delivery_status='location_pending' AND created_at<=?`)
      .run(new Date().toISOString(), new Date(Date.now() - 60000).toISOString());
    return this.db.prepare(`SELECT a.key, a.type, a.price, a.reference_price AS referencePrice,
      a.confidence, a.sample_count AS sampleCount, a.attempts,
      l.item_name AS itemName, l.shop, l.specification_json AS specificationJson,
      l.last_seen AS observedAt,
      a.location_map AS mapName, a.location_x AS x, a.location_y AS y,
      a.location_source AS locationSource, a.location_confidence AS locationConfidence
      FROM price_alerts a JOIN listings l ON l.key=a.listing_key
      WHERE l.server_id=? AND a.delivery_status='pending' AND a.attempts < 3 AND
      (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)
      ORDER BY a.created_at LIMIT ?`).all(SERVER_ID, new Date().toISOString(), limit);
  }

  claimDelivery(key) {
    return this.db.prepare(`UPDATE price_alerts SET delivery_status='sending',
      attempts=attempts+1, updated_at=?
      WHERE key=? AND delivery_status='pending' AND attempts<3`)
      .run(new Date().toISOString(), key).changes === 1;
  }

  markInterruptedDeliveries() {
    this.db.prepare(`UPDATE price_alerts SET delivery_status='uncertain',
      last_error='DELIVERY_OUTCOME_UNKNOWN', updated_at=? WHERE delivery_status='sending'`)
      .run(new Date().toISOString());
  }

  retryUncertainDelivery(key) {
    return this.db.prepare(`UPDATE price_alerts SET delivery_status='pending',
      attempts=0, next_attempt_at=NULL, updated_at=?
      WHERE key=? AND delivery_status='uncertain'`)
      .run(new Date().toISOString(), key).changes === 1;
  }

  locationPendingAlerts(limit = 20) {
    return this.db.prepare(`SELECT a.key, l.item_name AS itemName, l.shop,
      a.created_at AS createdAt FROM price_alerts a
      JOIN listings l ON l.key=a.listing_key
      WHERE l.server_id=? AND a.delivery_status='location_pending'
      ORDER BY a.created_at LIMIT ?`).all(SERVER_ID, limit);
  }

  markDelivery(key, status, error = null, nextAttemptAt = null, countAttempt = true) {
    this.db.prepare(`UPDATE price_alerts SET delivery_status=?, attempts=attempts+?,
      last_error=?, next_attempt_at=?, updated_at=? WHERE key=?`)
      .run(status, countAttempt ? 1 : 0, error, nextAttemptAt,
        new Date().toISOString(), key);
  }

  markRateLimited(key, nextAttemptAt) {
    this.db.prepare(`UPDATE price_alerts SET delivery_status='pending',
      attempts=MAX(0, attempts-1), last_error='HTTP_429',
      next_attempt_at=?, updated_at=? WHERE key=? AND delivery_status='sending'`)
      .run(nextAttemptAt, new Date().toISOString(), key);
  }

  status() {
    return {
      catalog: this.db.prepare("SELECT COUNT(*) AS count FROM catalog").get().count,
      listings: this.db.prepare("SELECT COUNT(*) AS count FROM listings WHERE server_id=?")
        .get(SERVER_ID).count,
      pendingAlerts: this.db.prepare(`SELECT COUNT(*) AS count FROM price_alerts a
        JOIN listings l ON l.key=a.listing_key WHERE l.server_id=?
        AND a.delivery_status='pending'`).get(SERVER_ID).count,
      locationPending: this.db.prepare(`SELECT COUNT(*) AS count FROM price_alerts a
        JOIN listings l ON l.key=a.listing_key WHERE l.server_id=?
        AND a.delivery_status='location_pending'`).get(SERVER_ID).count,
      coverage: this.db.prepare(`SELECT COUNT(*) AS known,
        SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned
        FROM search_keywords`).get(),
      lastRun: this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() ?? null,
      lastSearch: this.db.prepare(`SELECT last_search_at AS searchedAt, last_keyword AS keyword
        FROM scan_runs WHERE last_search_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get() ?? null,
      lastCompletedRun: this.db.prepare(`SELECT finished_at, status, listings_parsed
        FROM scan_runs WHERE finished_at IS NOT NULL AND status IN ('COMPLETE', 'PARTIAL')
        ORDER BY id DESC LIMIT 1`).get() ?? null,
      lastKeywordPages: this.db.prepare(`SELECT keyword, status, observed_count AS observedCount,
        reported_count AS reportedCount, page_count AS pageCount, verification
        FROM scan_keyword_pages ORDER BY run_id DESC, rowid DESC LIMIT 1`).get() ?? null
    };
  }

  close() { this.db.close(); }
}

module.exports = { MarketStore };
