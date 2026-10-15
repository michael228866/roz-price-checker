const { SERVER_ID } = require("./market.cjs");
const { navigationCommand } = require("./shop_location.cjs");

const MAX_PAGE = 100;

function pageNumber(value, fallback, max) {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new RangeError("分頁參數無效");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new RangeError("分頁參數超出範圍");
  return number;
}

function parseSpecification(value) {
  try { return value ? JSON.parse(value) : null; }
  catch { return null; }
}

class MarketRepository {
  constructor(store, { freshnessMinutes = 15 } = {}) {
    if (!Number.isInteger(freshnessMinutes) || freshnessMinutes < 1 ||
        freshnessMinutes > 1440) throw new RangeError("新鮮度時間無效");
    this.db = store.db;
    this.freshnessMs = freshnessMinutes * 60000;
  }

  summary(syncState = "IDLE") {
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(DISTINCT item_name) FROM listings WHERE server_id=?) AS knownItems,
      (SELECT COUNT(*) FROM listings WHERE server_id=?) AS listings,
      (SELECT COUNT(*) FROM listings WHERE server_id=? AND spec_complete=1) AS completeSpecifications,
      (SELECT COUNT(*) FROM listings WHERE server_id=? AND last_seen>=?) AS recentObservations,
      (SELECT COUNT(DISTINCT listing_key) FROM active_listing_refs WHERE expires_at>?) AS activeObservations,
      (SELECT COUNT(*) FROM price_alerts WHERE delivery_status='pending') AS pendingAlerts,
      (SELECT COUNT(*) FROM price_watchlist WHERE status='WATCHLIST') AS watchlist,
      (SELECT MAX(observed_at) FROM version_snapshots
        WHERE observation_quality='COMPLETE_PAGESET') AS lastOfficialObservation,
      (SELECT MAX(last_success_at) FROM data_sources) AS lastSync`).get(SERVER_ID, SERVER_ID,
      SERVER_ID, SERVER_ID, new Date(Date.now() - this.freshnessMs).toISOString(),
      new Date().toISOString());
    return { serverId: SERVER_ID, ...counts, syncState, asOf: new Date().toISOString() };
  }

  items(params) {
    const q = String(params.get("q") ?? "").trim();
    if (q.length > 100) throw new RangeError("搜尋字串過長");
    const limit = pageNumber(params.get("limit"), 25, MAX_PAGE);
    if (limit < 1) throw new RangeError("limit 必須大於 0");
    const cursor = pageNumber(params.get("cursor"), 0, 1000000);
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const where = "server_id=? AND item_name LIKE ? ESCAPE '\\'";
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT item_name, specification FROM listings WHERE ${where}
      GROUP BY item_name, specification)`).get(SERVER_ID, pattern).count;
    const rows = this.db.prepare(`SELECT item_name AS itemName, specification AS id,
      MIN(price) AS lowestPrice, COUNT(*) AS listingCount, MAX(last_seen) AS observedAt,
      MAX(spec_complete) AS specComplete
      FROM listings WHERE ${where} GROUP BY item_name, specification
      ORDER BY lowestPrice, item_name, id LIMIT ? OFFSET ?`)
      .all(SERVER_ID, pattern, limit, cursor);
    return { items: rows, total, nextCursor: cursor + rows.length < total
      ? String(cursor + rows.length) : null, source: "LOCAL_SQLITE", asOf: new Date().toISOString() };
  }

  listings(id, params) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new RangeError("商品規格 ID 無效");
    const limit = pageNumber(params.get("limit"), 25, MAX_PAGE);
    const cursor = pageNumber(params.get("cursor"), 0, 1000000);
    if (limit < 1) throw new RangeError("limit 必須大於 0");
    const now = new Date();
    const rows = this.db.prepare(`SELECT l.key, l.item_name AS itemName, l.shop,
      l.price, l.quantity, l.spec_complete AS specComplete,
      l.first_seen AS firstSeen, l.last_seen AS observedAt,
      l.specification_json AS specificationJson,
      l.location_map AS mapName, l.location_x AS x, l.location_y AS y,
      l.location_source AS locationSource, l.location_confidence AS locationConfidence,
      (SELECT GROUP_CONCAT(DISTINCT source_id) FROM source_observations s
        WHERE s.listing_key=l.key) AS sourceIds,
      (SELECT MAX(vs.observed_at) FROM version_snapshots vs
        JOIN listing_versions v ON v.key=vs.version_key
        WHERE v.listing_key=l.key AND vs.observation_quality='COMPLETE_PAGESET') AS lastVerifiedAt,
      EXISTS(SELECT 1 FROM active_listing_refs a WHERE a.listing_key=l.key
        AND a.expires_at>?) AS active
      FROM listings l WHERE l.server_id=? AND l.specification=?
      ORDER BY l.price, l.key LIMIT ? OFFSET ?`).all(now.toISOString(), SERVER_ID, id, limit, cursor);
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM listings WHERE server_id=? AND specification=?")
      .get(SERVER_ID, id).count;
    return { items: rows.map((row) => ({ ...row,
      specification: parseSpecification(row.specificationJson),
      ageSeconds: Math.max(0, Math.floor((now - new Date(row.observedAt)) / 1000)) || 0,
      state: row.active ? "VERIFIED_ACTIVE_OBSERVATION" :
        now - new Date(row.observedAt) <= this.freshnessMs
          ? "RECENT_OBSERVATION" : "STALE_OBSERVATION",
      source: row.sourceIds ?? "gnjoy-ui",
      sources: row.sourceIds?.split(",") ?? ["gnjoy-ui"],
      quality: row.specComplete ? "COMPLETE_SPEC" : "INCOMPLETE_SPEC",
      navigation: row.locationSource === "shop_detail_response" &&
        row.locationConfidence === "MATCHED_SHOP_DETAIL" ? navigationCommand(row) : null })),
    total, nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
    asOf: now.toISOString() };
  }

  history(id, range = "7d") {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new RangeError("商品規格 ID 無效");
    if (!["1d", "7d", "30d"].includes(range)) throw new RangeError("range 無效");
    const cutoff = new Date(Date.now() - Number.parseInt(range, 10) * 86400000).toISOString();
    const asks = this.db.prepare(`SELECT substr(observed_at, 1, 10) AS day,
      MIN(price) AS lowestAsk, COUNT(*) AS samples FROM (
      SELECT vs.version_key, vs.observed_at, v.price
      FROM version_snapshots vs JOIN listing_versions v ON v.key=vs.version_key
      WHERE v.server_id=? AND v.specification=? AND vs.observed_at>=?
      UNION
      SELECT o.version_key, o.observed_at, v.price FROM source_observations o
      JOIN listing_versions v ON v.key=o.version_key
      WHERE o.server_id=? AND o.source_id<>'gnjoy-ui' AND v.specification=?
        AND o.observed_at>=?)
      GROUP BY day ORDER BY day`).all(SERVER_ID, id, cutoff, SERVER_ID, id, cutoff);
    const sales = this.db.prepare(`SELECT substr(sold_at, 1, 10) AS day,
      MIN(price) AS lowestSale, COUNT(*) AS samples FROM sale_transactions
      WHERE server_id=? AND specification=? AND sold_at>=?
      GROUP BY day ORDER BY day`).all(SERVER_ID, id, cutoff);
    const current = this.db.prepare(`SELECT MIN(v.price) AS lowestAsk,
      COUNT(DISTINCT v.shop) AS independentSellers FROM active_listing_refs a
      JOIN listing_versions v ON v.key=a.version_key
      WHERE v.server_id=? AND v.specification=? AND a.expires_at>?`)
      .get(SERVER_ID, id, new Date().toISOString());
    const historicalLowest = this.db.prepare(`SELECT MIN(price) AS price FROM listing_versions
      WHERE server_id=? AND specification=?`).get(SERVER_ID, id).price;
    const baseline = this.db.prepare(`SELECT b.reference_price AS referenceMedian,
      b.sample_count AS sampleCount, r.started_at AS observedAt
      FROM market_baselines b JOIN scan_runs r ON r.id=b.run_id
      JOIN listings l ON l.key=b.listing_key
      WHERE l.server_id=? AND l.specification=? ORDER BY b.run_id DESC LIMIT 1`)
      .get(SERVER_ID, id) ?? null;
    return { id, range, asks, sales, current, historicalLowest, baseline,
      saleStatus: sales.length ? "AVAILABLE" : "NO_TRUSTED_SALES",
      asOf: new Date().toISOString(), source: "LOCAL_SQLITE" };
  }

  alerts(params) {
    const limit = pageNumber(params.get("limit"), 25, MAX_PAGE);
    const cursor = pageNumber(params.get("cursor"), 0, 1000000);
    if (limit < 1) throw new RangeError("limit 必須大於 0");
    const rows = this.db.prepare(`SELECT a.key, l.item_name AS itemName, l.shop,
      a.price, a.reference_price AS referencePrice, a.sample_count AS sampleCount,
      a.confidence, a.type, a.delivery_status AS deliveryStatus, a.location_status AS locationStatus,
      a.created_at AS createdAt, a.updated_at AS updatedAt, l.last_seen AS observedAt
      FROM price_alerts a JOIN listings l ON l.key=a.listing_key
      WHERE l.server_id=? ORDER BY a.created_at DESC, a.key LIMIT ? OFFSET ?`)
      .all(SERVER_ID, limit, cursor);
    const watchlist = this.db.prepare(`SELECT w.key, l.item_name AS itemName, l.shop,
      w.price, w.reference_price AS referencePrice, w.sample_count AS sampleCount,
      w.confidence, w.reason, w.source_id AS sourceId, w.observed_at AS observedAt,
      (SELECT GROUP_CONCAT(DISTINCT source_id) FROM source_observations s
        WHERE s.listing_key=w.listing_key) AS sources
      FROM price_watchlist w JOIN listings l ON l.key=w.listing_key
      WHERE w.status='WATCHLIST' ORDER BY w.observed_at DESC, w.key LIMIT ?`).all(limit);
    return { items: rows.map((row) => ({ ...row, source: "gnjoy-ui", verificationStatus:
      row.type === "VISIBLE_PAGE_LOW_PRICE" ? "UNVERIFIED" : "CONFIRMED_UI" })),
      watchlist, nextCursor: rows.length === limit ? String(cursor + limit) : null,
      asOf: new Date().toISOString() };
  }

  sources() { return this.db.prepare(`SELECT id, name, source_type AS sourceType,
    authorization_status AS authorizationStatus, enabled, last_success_at AS lastSuccessAt,
    last_error AS lastError FROM data_sources ORDER BY id`).all(); }

  coverage() { return this.db.prepare(`SELECT COUNT(*) AS known,
    SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned
    FROM search_keywords`).get(); }
}

module.exports = { MarketRepository };
