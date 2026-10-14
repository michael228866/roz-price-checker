async function collectPages(fetchPage, { maxPages = 20, pageSize = 30 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages 必須為正整數");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize 必須為正整數");
  const items = [];
  const seen = new Set();
  const seenPages = new Set();
  let reportedCount = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page);
    if (!result || !Array.isArray(result.items)) throw new Error(`第 ${page} 頁資料無效`);
    const pageFingerprint = JSON.stringify(result?.items?.map((item) =>
      [item.serverId, item.shop, item.ssi, item.itemName, item.specification,
        item.price, item.quantity]));
    if (seenPages.has(pageFingerprint)) {
      return { items, reportedCount, pageCount: page, status: "PARTIAL" };
    }
    seenPages.add(pageFingerprint);
    if (result.reportedCount !== null && result.reportedCount !== undefined) {
      if (reportedCount !== null && reportedCount !== result.reportedCount) {
        return { items, reportedCount, pageCount: page, status: "PARTIAL" };
      }
      reportedCount = result.reportedCount;
    }
    for (const item of result.items) {
      const key = JSON.stringify([item.serverId, item.shop, item.ssi ?? item.observationKey,
        item.itemName, item.specification, item.price, item.quantity]);
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    }
    if (result.items.length > pageSize ||
        (result.hasNext === true && result.items.length !== pageSize)) {
      return { items, reportedCount, pageCount: page, status: "PARTIAL" };
    }
    if (result.hasNext === false) {
      return { items, reportedCount, pageCount: page,
        status: result.countVerified === true && reportedCount === items.length ? "COMPLETE" : "PARTIAL" };
    }
    if (result.hasNext !== true) {
      return { items, reportedCount, pageCount: page, status: "PAGINATION_UNVERIFIED" };
    }
  }
  return { items, reportedCount, pageCount: maxPages, status: "PARTIAL" };
}

module.exports = { collectPages };
