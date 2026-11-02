// lib/venue-fees.js
// 🟢 AM72 — per-venue TAKER fee constants for the contract-spec panel.
//
// SEMANTICS: TAKER_FEE_BPS_PER_SIDE is PER SIDE (one fill). A round trip = 2×.
// The platform's own fee model (backtester default 0.0008 = 8 bps) charges 8 bps
// per side = 16 bps round trip — so coinbase is 8 here, NOT 16.
//
// TODO: these are BASE-TIER constants, not the real per-account tier schedule.
// Replace with a live tier lookup when the venue fee APIs are wired. Until then
// they are documented constants (honest-absent is NOT used — the panel shows the
// base tier with a "/side" label so the number is never misread as round-trip).
export const TAKER_FEE_BPS_PER_SIDE = {
  coinbase: 8,        // Coinbase INTX/CDE base tier (matches the 0.0008 backtester default)
  krakenspot: 26,     // Kraken Pro spot base tier (0.26%)
  krakenfutures: 5,   // Kraken Futures base tier (0.05%)
  kraken: 5,          // Kraken US (Bitnomial) — manual venue; base-tier placeholder
};

/**
 * Taker fee in bps PER SIDE for a venue. Unknown venue → null (honest-absent).
 */
export function takerFeeBpsPerSide(venue) {
  const key = String(venue || '').toLowerCase().trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(TAKER_FEE_BPS_PER_SIDE, key)
    ? TAKER_FEE_BPS_PER_SIDE[key]
    : null;
}

/**
 * Human label for the contract-spec panel, e.g. "Taker: 26 bps/side".
 * Unknown venue → "Taker: —".
 */
export function takerFeeLabel(venue) {
  const bps = takerFeeBpsPerSide(venue);
  return bps == null ? 'Taker: —' : `Taker: ${bps} bps/side`;
}
