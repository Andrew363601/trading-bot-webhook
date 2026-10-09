// lib/structure-direction.js
// 🟢 PUSH AM62b — pure market-structure resolver (no I/O, no env).
//
// REPLACES the AM62 v1 label-vs-CVD coin flip. Direction is DERIVED FROM PRICE
// STRUCTURE on the macro TF (EMA50 vs last close + N-bar slope); CVD is a
// TIEBREAK vote only — never a coin-flip against a directionless label. Pure,
// so it is unit-testable and can be re-run by the backfill script.
//
// Values are ALWAYS LONG | SHORT | NEUTRAL (migration 059 CHECK — never null).
// NEUTRAL now honestly means "flat / insufficient structure", NOT "the regime
// label disagreed with CVD".

export const EMA_PERIOD = 50;
export const SLOPE_BARS = 10;
// Need EMA_PERIOD + 1 closes to place the last close on the EMA, and
// SLOPE_BARS + 1 closes to measure the slope — the latter is the binding floor.
export const MIN_BARS = Math.max(EMA_PERIOD + 1, SLOPE_BARS + 1); // 51

const toCloses = (candles) => {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  return candles
    .map((c) => Number(c?.close))
    .filter((n) => Number.isFinite(n));
};

// Standard EMA seeded with the SMA of the first `period` values.
const ema = (values, period) => {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
};

/**
 * Structural bias from candles ALONE (CVD excluded).
 * `null` = flat (no clean slope) or insufficient structure (< MIN_BARS).
 *
 * candles: ascending-by-time [{ close }] OR a plain number[] of closes.
 */
export function computeStructureBias(candles) {
  const closes = Array.isArray(candles) && typeof candles[0] === 'number'
    ? candles.filter((n) => Number.isFinite(n))
    : toCloses(candles);
  if (closes.length < MIN_BARS) return null;

  const last = closes[closes.length - 1];

  const emaLast = ema(closes, EMA_PERIOD);
  const emaBias = (emaLast != null && Number.isFinite(emaLast))
    ? (last > emaLast ? 'LONG' : last < emaLast ? 'SHORT' : null)
    : null;

  const past = closes[closes.length - 1 - SLOPE_BARS];
  const slopeBias = Number.isFinite(past)
    ? (last > past ? 'LONG' : last < past ? 'SHORT' : null)
    : null;

  // The two structural reads must AGREE. A disagreement IS "no clean structure".
  if (emaBias && slopeBias) return emaBias === slopeBias ? emaBias : null;
  return emaBias || slopeBias || null;
}

/**
 * Final direction: price structure wins; CVD is a tiebreak vote ONLY.
 * Returns 'LONG' | 'SHORT' | 'NEUTRAL' (never null — 059 CHECK holds).
 */
export function deriveStructureDirection(candles, cvd) {
  const bias = computeStructureBias(candles);
  if (bias) return bias;
  const c = parseFloat(cvd);
  if (Number.isFinite(c) && c !== 0) return c > 0 ? 'LONG' : 'SHORT';
  return 'NEUTRAL';
}
