const UNKNOWN_LOCATION = "尚未取得商店位置";

function parseShopLocation(row, source = "shop_detail_response") {
  if (!row || typeof row.mapName !== "string") return null;
  const mapName = row.mapName.trim().replace(/\.gat$/i, "");
  const coordinate = (value) => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (!/^[1-9]\d*$/.test(String(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  };
  const x = coordinate(row.xPos);
  const y = coordinate(row.yPos);
  if (!/^[a-z][a-z0-9_]*$/i.test(mapName) || x === null || y === null) return null;
  return { mapName, x, y, source, confidence: "MATCHED_SHOP_DETAIL" };
}

function navigationCommand(location) {
  const valid = parseShopLocation({ mapName: location?.mapName,
    xPos: location?.x, yPos: location?.y });
  return valid ? `/navi ${valid.mapName} ${valid.x}/${valid.y}` : null;
}

module.exports = { UNKNOWN_LOCATION, parseShopLocation, navigationCommand };
