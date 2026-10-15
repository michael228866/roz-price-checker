function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value); value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  if (quoted) throw new Error("CSV 引號未結束");
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows.shift().map((cell) => cell.trim().replace(/^\uFEFF/, ""));
  const nameIndex = headers.findIndex((header) => ["itemName", "name", "商品名稱"].includes(header));
  const tierIndex = headers.findIndex((header) => ["tier", "priority", "優先級"].includes(header));
  if (nameIndex < 0) throw new Error("CSV 需要 itemName、name 或 商品名稱 欄");
  const items = new Map();
  for (const cells of rows) {
    const name = cells[nameIndex]?.trim();
    if (!name) continue;
    const tier = cells[tierIndex]?.trim() || "P1";
    if (!["P0", "P1", "P2"].includes(tier)) throw new Error(`無效優先級：${tier}`);
    items.set(name, { name, tier });
  }
  return [...items.values()];
}

module.exports = { parseCsv, parseCsvRows };
