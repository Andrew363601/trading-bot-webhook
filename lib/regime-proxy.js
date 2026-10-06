// lib/regime-proxy.js
// PUSH AM50 — OHLCV-only regime proxy labeler.
// PUSH AM53b2 — parameterized classifier (calibration) + proxy_v2 constants.
//
// WHY: Backtests have no regime identity, so the agent can't learn "which
// params work in which regime". The live canon classifier (workers/sniper.js
// classifyCanonRegime) needs POC / CVD / order-book depth that a historical
// OHLCV replay cannot reproduce, so this is a deliberate PROXY: it emits
// EXACTLY the canon vocabulary so backtest rows and live rows share one label
// space — 'TREND' | 'CHOP' | 'ACCUMULATION' | 'DISTRIBUTION'.
//
// HARD CONSTRAINT: OHLCV-only inputs. No orderbook / CVD / POC. Those are
// live-side canon only. Pure + deterministic: same candles -> same label,
// always (no Date / random / external state).

export const REGIME_PROXY_VERSION = 'proxy_v2';

// Tunable constants at top, single source of truth. Exported so the AM53b2
// calibration script can grid-search them through the SAME code path the
// backtester uses (no hand-maintained replica).
export const REGIME_PROXY_CONSTANTS = Object.freeze({
  DISPLACEMENT_TREND: 0.2,   // |ema50 slope| / ATR14 — calibrated (AM53b2 LIVE, 166 rows)
  RANGE_COMPRESSION: 0.8,    // rolling range width / baseline volatility (kept)
  POS_ACCUM_MAX: 0.2,        // range position lower bound — edge-pinned, n=0, uncalibrated
  POS_DIST_MIN: 0.55,        // range position upper bound — edge-pinned, n=0, uncalibrated
  ROLL_BARS: 96,
  EMA_PERIOD: 50,
  ATR_PERIOD: 14,
  SLOPE_LOOKBACK: 8,         // bars for the EMA50 slope read
  // Compression must be measured against RECENT PAST volatility, not the range
  // window's own ATR. If the baseline window <= ROLL_BARS then VolBaseline <= span
  // always (all true ranges live inside [rollLow, rollHigh]) => rangeWidth >= 1,
  // making the compression branch dead code. A longer baseline (3x ROLL_BARS)
  // lets a quiet consolidation register as width < 1.
  VOL_BARS: 288,             // ROLL_BARS * 3 — compression volatility baseline
});

/** Wilder-smoothed average true range over the last `period` bars (per-bar TR). */
function wilderATR(candles, period) {
  if (!candles || candles.length < 2) return 0;
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = Number(c.high);
    const low = Number(c.low);
    const prevClose = i > 0 ? Number(candles[i - 1].close) : Number(c.open);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(Number.isFinite(tr) ? tr : 0);
  }
  const window = trs.slice(-period);
  if (window.length === 0) return 0;
  let atr = window[0];
  for (let i = 1; i < window.length; i++) {
    atr = (atr * (period - 1) + window[i]) / period;
  }
  return atr;
}

/** Simple EMA over a numeric array; returns the final EMA value (or null). */
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/**
 * Extract the three grid-independent regime features from macro OHLCV candles.
 * Only the structural constants (windows/periods) affect these values; the
 * four tunable thresholds do not. Returns null when the series is unusable
 * (insufficient / non-finite) — callers map null to 'CHOP'.
 *
 * @param {Array<{open:number,high:number,low:number,close:number,volume?:number}>} macroCandles
 * @param {typeof REGIME_PROXY_CONSTANTS} [constants]
 * @returns {{displacement:number, rangeWidth:number, rangePos:number}|null}
 */
export function regimeProxyFeatures(macroCandles, constants = REGIME_PROXY_CONSTANTS) {
  const { ROLL_BARS, EMA_PERIOD, ATR_PERIOD, SLOPE_LOOKBACK, VOL_BARS } = constants;

  // 1. Insufficient candles -> null (caller maps to 'CHOP').
  const candles = Array.isArray(macroCandles) ? macroCandles : [];
  if (candles.length < EMA_PERIOD) return null;

  const closes = candles.map((c) => Number(c.close));
  if (closes.some((v) => !Number.isFinite(v))) return null;

  // Displacement uses the fast ATR14; compression uses a longer baseline.
  const atr14 = Math.max(wilderATR(candles, ATR_PERIOD), 1e-9);
  const volBaseline = Math.max(wilderATR(candles, Math.min(VOL_BARS, candles.length)), 1e-9);

  // 2. EMA50 slope -> "displacement" = (ema[last] - ema[last-8]) / ATR14.
  const emaNow = ema(closes, EMA_PERIOD);
  const emaPrev = ema(closes.slice(0, closes.length - SLOPE_LOOKBACK), EMA_PERIOD);
  if (emaNow == null || emaPrev == null) return null;
  const displacement = (emaNow - emaPrev) / atr14;

  // 3. Rolling high/low over the last ROLL_BARS.
  const roll = candles.slice(-ROLL_BARS);
  const rollHigh = Math.max(...roll.map((c) => Number(c.high)));
  const rollLow = Math.min(...roll.map((c) => Number(c.low)));
  const span = rollHigh - rollLow;
  const close = closes[closes.length - 1];

  // rangePos guarded against div0 (flat window -> treat as mid = 0.5).
  const rangePos = span > 0 ? (close - rollLow) / span : 0.5;
  // Compression = current range vs RECENT PAST volatility (VOL_BARS > ROLL_BARS).
  const rangeWidth = span / volBaseline;

  return { displacement, rangeWidth, rangePos };
}

/**
 * Apply the four tunable thresholds to precomputed features (first match wins).
 * Kept separate so the AM53b2 grid-search can reuse features across combos.
 *
 * @param {{displacement:number, rangeWidth:number, rangePos:number}|null} f
 * @param {{DISPLACEMENT_TREND:number, RANGE_COMPRESSION:number, POS_ACCUM_MAX:number, POS_DIST_MIN:number}} t
 * @returns {'TREND'|'CHOP'|'ACCUMULATION'|'DISTRIBUTION'}
 */
export function classifyRegimeFromFeatures(f, t) {
  if (!f) return 'CHOP';
  if (Math.abs(f.displacement) >= t.DISPLACEMENT_TREND) return 'TREND';
  if (f.rangeWidth <= t.RANGE_COMPRESSION && f.rangePos >= t.POS_DIST_MIN) return 'DISTRIBUTION';
  if (f.rangeWidth <= t.RANGE_COMPRESSION && f.rangePos <= t.POS_ACCUM_MAX) return 'ACCUMULATION';
  return 'CHOP';
}

/**
 * Classify the market regime from macro OHLCV candles only, using an explicit
 * constants object. This is the single code path shared by production
 * (`classifyRegimeProxy`) and the AM53b2 calibration grid-search.
 *
 * @param {Array<{open:number,high:number,low:number,close:number,volume?:number}>} macroCandles
 * @param {typeof REGIME_PROXY_CONSTANTS} [constants]
 * @returns {'TREND'|'CHOP'|'ACCUMULATION'|'DISTRIBUTION'} never null
 */
export function classifyRegimeProxyWith(macroCandles, constants = REGIME_PROXY_CONSTANTS) {
  return classifyRegimeFromFeatures(regimeProxyFeatures(macroCandles, constants), constants);
}

/**
 * Classify the market regime from macro OHLCV candles only (production entry).
 *
 * @param {Array<{open:number,high:number,low:number,close:number,volume?:number}>} macroCandles
 * @returns {'TREND'|'CHOP'|'ACCUMULATION'|'DISTRIBUTION'} never null
 */
export function classifyRegimeProxy(macroCandles) {
  return classifyRegimeProxyWith(macroCandles, REGIME_PROXY_CONSTANTS);
}
