function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function planKeywords({ manual = [], catalog = [], hot = [], cursor = 0,
  limit = 20 } = {}) {
  const watched = unique(manual);
  const dueAll = unique(catalog);
  const due = dueAll.filter((name) => !watched.includes(name));
  const popular = unique(hot).filter((name) => !watched.includes(name) && !due.includes(name));
  const catalogSlots = Math.min(4, due.length, limit);
  const hotSlots = Math.min(2, popular.length, Math.max(0, limit - catalogSlots));
  const manualSlots = Math.min(watched.length, limit - catalogSlots - hotSlots);
  const start = watched.length ? cursor % watched.length : 0;
  const chosenManual = Array.from({ length: manualSlots }, (_, index) =>
    watched[(start + index) % watched.length]);
  const chosenCatalog = due.slice(0, catalogSlots);
  const chosenHot = popular.slice(0, hotSlots);
  const keywords = [...chosenManual, ...chosenCatalog, ...chosenHot];
  for (const extra of [...watched, ...due, ...popular]) {
    if (keywords.length >= limit) break;
    if (!keywords.includes(extra)) keywords.push(extra);
  }
  return { keywords, catalogDue: keywords.filter((name) => dueAll.includes(name)),
    nextCursor: watched.length ? (start + manualSlots) % watched.length : 0,
    wasCapped: watched.length + due.length + popular.length > limit };
}

module.exports = { planKeywords };
