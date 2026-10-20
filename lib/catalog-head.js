// lib/catalog-head.js
// 🟢 AM69 hotfix 1 — CATALOG HEAD PROTECTION.
//
// Extracted from the coinbase TOP_RANK precedent in pages/api/available-assets.js:
// the priority majors must NEVER be sliced off the end by volume/sort health. A
// venue whose tickers are dark (or whose sort is alphabetical) can otherwise push
// BTC/ETH/XRP past the .slice(0, 100) cut and hide them from the picker.
//
// Guarantees each priority key is present (pushed at head if absent) and sorts
// priority-bucket-first, then by the supplied comparator. Pure + dependency-free so
// the gate can dynamic-import it (no supabase/env side effects).

// The majors every venue matrix must always surface. Order = display priority.
export const PRIORITY_BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'LTC', 'DOGE', 'AVAX', 'LINK'];

/**
 * @param {Array} products - the venue's mapped products (unsorted)
 * @param {string[]} priorityKeys - the keys that must survive the head cut
 * @param {(p:object)=>string} keyOf - how to read a product's priority key
 * @param {(a:object,b:object)=>number} [compareWithinBucket] - order inside a bucket
 * @param {(key:string)=>object} makePlaceholder - builds a head placeholder for a
 *        missing priority key (mirrors the coinbase L188-194 push)
 * @returns {Array} the ranked products (caller slices)
 */
export function guaranteePriorityHead(products, priorityKeys, keyOf, compareWithinBucket, makePlaceholder) {
  const rank = new Map(priorityKeys.map((k, idx) => [k, idx]));
  const combined = [...products];
  priorityKeys.forEach((k) => {
    if (!combined.find((p) => keyOf(p) === k)) combined.push(makePlaceholder(k));
  });
  return combined.sort((a, b) => {
    const aRank = rank.has(keyOf(a)) ? rank.get(keyOf(a)) : Infinity;
    const bRank = rank.has(keyOf(b)) ? rank.get(keyOf(b)) : Infinity;
    if (aRank !== bRank) return aRank - bRank;
    return compareWithinBucket ? compareWithinBucket(a, b) : 0;
  });
}
