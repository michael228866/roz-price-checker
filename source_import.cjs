const crypto = require("node:crypto");
const { parseCsvRows } = require("./catalog.cjs");
const { SERVER_ID, fingerprint, listingKey, listingVersion } = require("./market.cjs");
const { parseShopLocation } = require("./shop_location.cjs");

const fields = ["itemName", "itemRefining", "ItemGradeLevel", "DefaultSlotCount",
  "slot_1", "slot_2", "slot_3", "slot_4", "RandomOpt1", "RandomOpt2",
  "RandomOpt3", "RandomOpt4", "RandomOpt5"];

function parseRows(content, format) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 5 * 1024 * 1024) {
    throw new RangeError("匯入檔案不可超過 5 MB");
  }
  if (format === "json") {
    const rows = JSON.parse(content);
    if (!Array.isArray(rows)) throw new TypeError("JSON 必須是物件陣列");
    return rows;
  }
  if (format !== "csv") throw new TypeError("只支援 CSV 或 JSON");
  const [headers, ...rows] = parseCsvRows(content);
  const names = headers?.map((name) => name.trim().replace(/^\uFEFF/, ""));
  if (!names || names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new TypeError("CSV 標題無效或重複");
  }
  return rows.map((cells) => {
    if (cells.length !== names.length) return null;
    return Object.fromEntries(names.map((name, index) => [name, cells[index].trim()]));
  });
}

function validateRow(row, sourceId) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("資料列不是物件");
  if (Number(row.serverId) !== SERVER_ID) throw new TypeError("Server ID 必須為 529");
  if (row.sourceId !== sourceId) throw new TypeError("sourceId 不符");
  for (const key of ["itemName", "shop", "sourceListingId"]) {
    if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > 200) {
      throw new TypeError(`${key} 無效`);
    }
  }
  if (row.canonicalListingId !== undefined && row.canonicalListingId !== "" &&
      (typeof row.canonicalListingId !== "string" ||
        row.canonicalListingId.length > 200 || !row.canonicalListingId.trim())) {
    throw new TypeError("canonicalListingId 無效");
  }
  const positiveInteger = (value) => (typeof value === "number" ||
    typeof value === "string" && /^[1-9]\d*$/.test(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (!positiveInteger(row.price) || !positiveInteger(row.quantity)) {
    throw new TypeError("價格或數量無效");
  }
  const price = Number(row.price);
  const quantity = Number(row.quantity);
  if (row.storeType !== "販售") throw new TypeError("只接受販售掛單");
  if (typeof row.observedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.observedAt) ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      Date.parse(row.observedAt) > Date.now() + 300000) throw new TypeError("observedAt 無效");
  if ([row.mapName, row.xPos, row.yPos].some((value) => value !== undefined && value !== "") &&
      !parseShopLocation(row)) throw new TypeError("座標欄位無效");
  const specComplete = fields.every((key) => row[key] !== undefined && row[key] !== null && row[key] !== "");
  for (const key of ["itemRefining", "ItemGradeLevel", "DefaultSlotCount"]) {
    if (row[key] !== undefined && row[key] !== "" &&
        (!Number.isSafeInteger(Number(row[key])) || Number(row[key]) < 0)) {
      throw new TypeError(`${key} 無效`);
    }
  }
  for (const key of fields.slice(4)) {
    if (row[key] !== undefined && row[key] !== null &&
        (typeof row[key] !== "string" && typeof row[key] !== "number" ||
          String(row[key]).length > 200)) throw new TypeError(`${key} 無效`);
  }
  const spec = Object.fromEntries(fields.map((key) => [key,
    row[key] === "" || row[key] === undefined ? null :
      ["itemRefining", "ItemGradeLevel", "DefaultSlotCount"].includes(key)
        ? Number(row[key]) : String(row[key])]));
  const item = { serverId: SERVER_ID, itemName: row.itemName.trim(), shop: row.shop.trim(),
    price, quantity, storeType: "販售", specification: fingerprint(spec), specComplete,
    observationKey: row.canonicalListingId
      ? `canonical:${row.canonicalListingId.trim()}`
      : `source:${sourceId}:${row.sourceListingId.trim()}`, ssi: null,
    observedAt: row.observedAt, specificationJson: JSON.stringify(spec) };
  return { ...item, listingKey: listingKey(item), versionKey: listingVersion(item),
    sourceListingId: row.sourceListingId.trim() };
}

class AuthorizedFileAdapter {
  constructor(sourceId, authorizationReference) {
    this.sourceId = sourceId;
    this.sourceType = "AUTHORIZED_IMPORT";
    this.permissionStatus = authorizationReference ? "AUTHORIZED_BY_USER" : "AUTHORIZATION_REQUIRED";
    this.capabilities = { csv: true, json: true, incrementalSync: false };
    this.authorizationReference = authorizationReference;
  }

  validateConfiguration() {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(this.sourceId) ||
        typeof this.authorizationReference !== "string" ||
        !this.authorizationReference.trim() || this.authorizationReference.length > 300) {
      throw new TypeError("需要有效來源 ID 與授權依據");
    }
  }

  fetchOrImport(content, format) {
    this.validateConfiguration();
    const raw = parseRows(content, format);
    if (raw.length > 50000) throw new RangeError("單次最多匯入 50000 列");
    const valid = [];
    const errors = [];
    const seen = new Set();
    raw.forEach((row, index) => {
      try {
        const item = this.normalize(row);
        const identity = `${item.sourceListingId}:${item.observedAt}`;
        if (seen.has(identity)) throw new TypeError("檔案內重複觀測");
        seen.add(identity);
        valid.push(item);
      } catch (error) { errors.push({ row: index + 2, error: error.message }); }
    });
    return { sourceId: this.sourceId,
      fileHash: crypto.createHash("sha256").update(content).digest("hex"),
      received: raw.length, valid, errors };
  }

  normalize(row) { return validateRow(row, this.sourceId); }
  reportStatus() { return { sourceId: this.sourceId, permissionStatus: this.permissionStatus,
    capabilities: this.capabilities }; }
}

class OfficialApiAdapter {
  constructor() {
    this.sourceId = "official-api";
    this.sourceType = "AUTHORIZED_API";
    this.permissionStatus = "AUTHORIZATION_REQUIRED";
    this.capabilities = { incrementalSync: false };
  }
  validateConfiguration() { throw new Error("AUTHORIZATION_REQUIRED"); }
  fetchOrImport() { this.validateConfiguration(); }
  normalize() { this.validateConfiguration(); }
  reportStatus() { return { sourceId: this.sourceId, permissionStatus: this.permissionStatus }; }
}

class MockOfficialApiAdapter extends OfficialApiAdapter {
  constructor(rows = []) {
    super();
    this.permissionStatus = "MOCK_ONLY";
    this.rows = rows;
  }
  validateConfiguration() { return true; }
  fetchOrImport() { return this.rows.map((row) => this.normalize(row)); }
  normalize(row) { return validateRow(row, this.sourceId); }
}

module.exports = { AuthorizedFileAdapter, OfficialApiAdapter, MockOfficialApiAdapter };
