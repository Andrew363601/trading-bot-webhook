// lib/asset-contract-size.js
// 🟢 PUSH AM29 — shared contract-size (multiplier) lookup.
//
// The per-symbol multiplier table previously existed as two DUPLICATED inline
// maps: workers/watchdog.js getAssetMetrics() and the execute path in
// lib/execute-trade-mcp.js (which resolves dynamic specs from Coinbase and
// falls back to 1.0). Read-time analytics consumers — such as the % of entry
// normalization in pages/api/performance/timeline.js — share this module.
// Matching order mirrors getAssetMetrics() exactly (substring includes, first
// match wins; ETP/ETH checked before BIT/BIP/BTC).
//
// Trade execution still resolves DYNAMIC specs from Coinbase
// (lib/execute-trade-mcp.js getAssetSpecs) — this static fallback is for
// read-time math only and deliberately does not touch those call sites.
//
// Fallback 1.0 mirrors the execute-path convention: assetSpecs.contract_size || 1.0.

const CONTRACT_SIZES = [
  { match: ['ETP', 'ETH'], size: 0.1 },
  { match: ['BIT', 'BIP', 'BTC'], size: 0.01 },
  { match: ['SLP', 'SOL'], size: 5.0 },
  { match: ['DOP', 'DOGE'], size: 1000.0 },
  { match: ['LCP', 'LTC'], size: 1.0 },
  { match: ['AVP', 'AVAX'], size: 1.0 },
  { match: ['LNP', 'LINK'], size: 1.0 },
];

export function contractSizeFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  for (const row of CONTRACT_SIZES) {
    if (row.match.some((m) => s.includes(m))) return row.size;
  }
  return 1.0;
}
