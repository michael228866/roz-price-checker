async function collectPages(fetchPage, { maxPages = 20 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages 必須為正整數");
  const items = [];
  const seen = new Set();
  const seenPages = new Set();
  let reportedCount = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page);
    const pageFingerprint = JSON.stringify(result?.items?.map((item) =>
      [item.shop, item.itemName, item.specification, item.price, item.quantity]));
    if (seenPages.has(pageFingerprint)) {
      return { items, reportedCount, pageCount: page, status: "PARTIAL" };
    }
    seenPages.add(pageFingerprint);
    if (!result || !Array.isArray(result.items)) throw new Error(`第 ${page} 頁資料無效`);
    if (result.reportedCount !== null && result.reportedCount !== undefined) reportedCount = result.reportedCount;
    for (const item of result.items) {
      const key = JSON.stringify([item.shop, item.specification, item.price, item.quantity]);
      if (!seen.has(key)) { seen.add(key); items.push(item); }
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
