const crypto = require("node:crypto");
const { parseShopLocation } = require("./shop_location.cjs");
const SERVER_ID = 529;

const specificationFields = [
  "itemName", "itemRefining", "ItemGradeLevel", "DefaultSlotCount",
  "slot_1", "slot_2", "slot_3", "slot_4",
  "RandomOpt1", "RandomOpt2", "RandomOpt3", "RandomOpt4", "RandomOpt5"
];

function fingerprint(item) {
  const specification = Object.fromEntries(specificationFields.map((field) => [field, item[field] ?? null]));
  return crypto.createHash("sha256").update(JSON.stringify(specification)).digest("hex");
}

function displayName(row) {
  const grade = { 1: "D階", 2: "C階", 3: "B階", 4: "A階" }[row.ItemGradeLevel];
  const parts = [];
  if (row.itemRefining > 0) parts.push(`+${row.itemRefining}`);
  if (grade) parts.push(grade);
  parts.push(row.itemName);
  for (const field of ["slot_1", "slot_2", "slot_3", "slot_4",
    "RandomOpt1", "RandomOpt2", "RandomOpt3", "RandomOpt4", "RandomOpt5"]) {
    if (row[field]) parts.push(row[field]);
  }
  return parts.join(" ").trim();
}

function parseResponse(payload, { keyword = "", serverId = SERVER_ID } = {}) {
  if (serverId !== SERVER_ID) throw new Error(`只允許 Server ID ${SERVER_ID}`);
  if (!payload || !Array.isArray(payload.dt)) throw new Error("查詢回應缺少 dt 掛單陣列");
  const items = [];
  const errors = [];
  for (const [index, row] of payload.dt.entries()) {
    const price = row?.itemPrice;
    const quantity = row?.itemCNT;
    if (row?.serverId != null && Number(row.serverId) !== SERVER_ID) {
      errors.push(`dt[${index}] 伺服器不符`);
      continue;
    }
    if (!row || typeof row.itemName !== "string" || !row.itemName.trim() ||
        !Number.isSafeInteger(price) || price <= 0 ||
        !Number.isSafeInteger(quantity) || quantity <= 0) {
      errors.push(`dt[${index}] 欄位無效`);
      continue;
    }
    const item = {
      keyword, serverId, shop: String(row.storeName ?? "").trim(),
      itemName: row.itemName, displayName: displayName(row),
      price, quantity, storeType: row.storetype, specification: fingerprint(row),
      ssi: row.SSI2 == null ? null : String(row.SSI2),
      location: parseShopLocation(row, "search_response"),
      specComplete: specificationFields.every((field) => row[field] !== undefined && row[field] !== null),
      source: "response"
    };
    items.push(item);
  }
  const rawCount = payload.dt2?.[0]?.count;
  const count = typeof rawCount === "string" && /^\d+$/.test(rawCount)
    ? Number(rawCount) : rawCount;
  return {
    items, errors,
    reportedCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    paginationStatus: "PAGINATION_UNVERIFIED"
  };
}

function fromVisibleRows(rows, keyword, serverId = SERVER_ID) {
  if (serverId !== SERVER_ID) throw new Error(`只允許 Server ID ${SERVER_ID}`);
  return rows.filter((row) => row.storeType === "販售" &&
    Number.isSafeInteger(row.price) && row.price > 0 &&
    Number.isSafeInteger(row.quantity) && row.quantity > 0 && row.itemName)
    .map((row) => ({
      keyword, serverId, shop: row.shop, itemName: row.itemName,
      slots: row.slots, price: row.price, quantity: row.quantity, storeType: row.storeType,
      specification: fingerprint({ itemName: row.itemName, DefaultSlotCount: row.slots }),
      specComplete: false, source: "visible_rows",
      ssi: row.ssi ?? null, location: null
    }));
}

function classify(ratio) {
  if (ratio < 0.07) return "EXTREME_UNDERPRICE";
  if (ratio <= 0.13) return "POSSIBLE_MISSING_ZERO";
  if (ratio <= 0.30) return "SIGNIFICANT_UNDERPRICE";
  if (ratio <= 0.60) return "DISCOUNT_WATCH";
  return "NORMAL";
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function listingIdentity(item) {
  return crypto.createHash("sha256").update(JSON.stringify([
    item.serverId, item.shop, item.specification,
    item.ssi ?? item.observationKey ?? null
  ])).digest("hex");
}

function analyze(items, history = [], recent = []) {
  const groups = new Map();
  const latest = new Map();
  for (const item of [...history, ...items]) {
    if (!Number.isSafeInteger(item.price) || item.price <= 0 ||
        item.serverId !== SERVER_ID || item.marketKind === "ASK_HISTORY" ||
        item.marketKind === "SALE_HISTORY" || item.marketKind === "RECENT_ASK" ||
        item.storeType !== "販售" ||
        !item.specComplete || !item.shop) continue;
    latest.set(listingIdentity(item), item);
  }
  for (const item of latest.values()) {
    const key = `${item.serverId}:${item.specification}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const results = [];
  for (const group of groups.values()) {
    for (const item of group) {
      if (!items.some((current) => listingIdentity(current) === listingIdentity(item))) continue;
      const independent = new Map();
      for (const other of group) {
        if (listingIdentity(other) === listingIdentity(item) || other.shop === item.shop) continue;
        const existing = independent.get(other.shop);
        if (!existing || other.price < existing.price) independent.set(other.shop, other);
      }
      const references = [...independent.values()];
      if (!references.length) continue;
      const referencePrice = median(references.map((entry) => entry.price));
      const ratio = item.price / referencePrice;
      const confidence = references.length >= 5 ? "HIGH" :
        references.length >= 3 ? "MEDIUM" : "LOW";
      const recentSampleCount = new Set(recent.filter((entry) =>
        entry.serverId === SERVER_ID && entry.specification === item.specification &&
        entry.shop !== item.shop).map((entry) => entry.shop)).size;
      results.push({ ...item, referencePrice, ratio, sampleCount: references.length,
        recentSampleCount, baselineSource: "VERIFIED_ACTIVE_ASK",
        confidence, anomalyType: classify(ratio),
        missingZeroMatch: ratio >= 0.085 && ratio <= 0.115 });
    }
  }
  return results;
}

function listingKey(item) {
  return listingIdentity(item);
}

function listingVersion(item) {
  return crypto.createHash("sha256").update(JSON.stringify([
    listingIdentity(item), item.price, item.quantity
  ])).digest("hex");
}

module.exports = { SERVER_ID, fingerprint, parseResponse, fromVisibleRows, analyze,
  listingKey, listingIdentity, listingVersion };
