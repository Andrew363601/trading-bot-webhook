// lib/venue-meta.js
// 🟢 AM70 — VENUE IDENTITY: the SINGLE SOURCE OF TRUTH for venue label + accent +
// copy, shared by the scanner (venue row, sync/empty copy, --acc accent) and the
// strategy card (venue badge). Extracted VERBATIM from components/MarketScanner.js
// (AM64) so the card and the matrix read as ONE system — no duplicated literal map.
//
// `venueFromAssetId` is PURE: the venue is bound at DEPLOY time and encoded in the
// strategy's `asset` id, so the id alone is authoritative. Unknown/absent → null
// (LOUD-absent: callers render nothing rather than guessing a venue).

// The venue keys are the lowercase ROUTING literals ('coinbase' | 'kraken' |
// 'krakenfutures' | 'krakenspot') — the same values written to strategy_config.exchange.
export const VENUE_META = {
  coinbase: {
    label: 'Coinbase',
    accent: '#0B6BFF',
    sync: 'Syncing with Coinbase...',
    matrixName: 'Coinbase INTX matrix',
  },
  // 🟢 AM68 — the US-futures rail is MANUAL-only in the Pro UI (KDUS/Bitnomial via
  // NinjaTrader Clearing); Kraken exposes NO API for it. Label carries the truth.
  kraken: {
    label: 'Kraken US (Bitnomial · manual)',
    accent: '#FF8A3C',
    sync: 'Syncing with Kraken US (Bitnomial)...',
    matrixName: 'Bitnomial US matrix',
  },
  krakenfutures: {
    label: 'Kraken Futures',
    accent: '#7C5CFF',
    sync: 'Syncing with Kraken Futures...',
    matrixName: 'Kraken Futures matrix',
  },
  // 🟢 AM68 — Kraken SPOT (+ margin): the working Kraken lane for a US account.
  krakenspot: {
    label: 'Kraken Spot',
    accent: '#14B8A6',
    sync: 'Syncing with Kraken Spot...',
    matrixName: 'Kraken Spot matrix',
  },
};

// Suffix → venue key. Order matters: the SPOT/KRF/KRX markers are checked BEFORE
// the generic -PERP-INTX/-CDE fall-through (a KRX id also contains '-PERP-').
//   SOL-SPOT-KRS      → krakenspot
//   SOL-PERP-KRX-5000 → kraken        (Bitnomial; size suffix after the marker)
//   SOL-PERP-KRF      → krakenfutures (apiv3; NO trailing dash)
//   SOL-PERP-INTX     → coinbase
//   BCP-20DEC30-CDE   → coinbase
//   anything else     → null (unknown — never guess)
export function venueFromAssetId(assetId) {
  const s = String(assetId || '').toUpperCase().trim();
  if (!s) return null;
  if (s.includes('-SPOT-KRS')) return 'krakenspot';
  if (s.includes('-PERP-KRX-')) return 'kraken';
  if (s.includes('-PERP-KRF')) return 'krakenfutures';
  if (s.includes('-PERP-INTX') || s.includes('-CDE')) return 'coinbase';
  return null;
}
