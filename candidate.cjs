const { analyze } = require("./market.cjs");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function findCandidates(listings, { ratio = 0.15, minimumComparables = 3 } = {}) {
  return analyze(listings).filter((item) => item.sampleCount >= minimumComparables &&
    item.confidence !== "LOW" && item.ratio <= ratio);
}

module.exports = { findCandidates, median };
