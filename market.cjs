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
      specificationJson: JSON.stringify(Object.fromEntries(specificationFields
        .map((field) => [field, row[field] ?? null]))),
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
  const current = new Set(items.map(listingIdentity));
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
  const recentSellers = new Map();
  for (const item of recent) {
    if (item.serverId !== SERVER_ID) continue;
    const sellers = recentSellers.get(item.specification) ?? new Set();
    sellers.add(item.shop);
    recentSellers.set(item.specification, sellers);
  }
  for (const group of groups.values()) {
    const cheapestBySeller = new Map();
    for (const item of group) {
      const previous = cheapestBySeller.get(item.shop);
      if (previous === undefined || item.price < previous) cheapestBySeller.set(item.shop, item.price);
    }
    const sorted = [...cheapestBySeller].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const sellerIndex = new Map(sorted.map(([shop], index) => [shop, index]));
    for (const item of group) {
      if (!current.has(listingIdentity(item))) continue;
      const excluded = sellerIndex.get(item.shop);
      const sampleCount = sorted.length - (excluded === undefined ? 0 : 1);
      if (!sampleCount) continue;
      const at = (index) => sorted[index + (excluded !== undefined && index >= excluded ? 1 : 0)][1];
      const middle = Math.floor(sampleCount / 2);
      const referencePrice = sampleCount % 2 ? at(middle) :
        (at(middle - 1) + at(middle)) / 2;
      const ratio = item.price / referencePrice;
      const confidence = sampleCount >= 5 ? "HIGH" :
        sampleCount >= 3 ? "MEDIUM" : "LOW";
      const recentGroup = recentSellers.get(item.specification);
      const recentSampleCount = recentGroup ? recentGroup.size - (recentGroup.has(item.shop) ? 1 : 0) : 0;
      results.push({ ...item, referencePrice, ratio, sampleCount,
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
