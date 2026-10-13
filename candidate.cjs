function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function findCandidates(listings, { ratio = 0.15, minimumComparables = 3 } = {}) {
  const groups = new Map();
  const seen = new Set();

  for (const listing of listings) {
    if (listing.storeType !== "販售" || !Number.isFinite(listing.price) || listing.price <= 0) {
      continue;
    }

    const identity = JSON.stringify([listing.shop, listing.itemName, listing.slots, listing.price, listing.quantity, listing.storeType]);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const key = `${listing.itemName}\u0000${listing.slots}`;
    const group = groups.get(key) ?? [];
    group.push(listing);
    groups.set(key, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    if (group.length < minimumComparables) {
      continue;
    }

    const referencePrice = median(group.map((listing) => listing.price));
    for (const listing of group) {
      if (listing.price <= referencePrice * ratio) {
        candidates.push({ ...listing, referencePrice });
      }
    }
  }
  return candidates;
}

module.exports = { findCandidates, median };
