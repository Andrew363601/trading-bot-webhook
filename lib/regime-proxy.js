// lib/regime-proxy.js
// PUSH AM50 — OHLCV-only regime proxy labeler.
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

export const REGIME_PROXY_VERSION = 'proxy_v1';

// Tunable constants at top, single source of truth.
const DISPLACEMENT_TREND = 1.2;   // |ema50 slope| / ATR14
const RANGE_COMPRESSION  = 0.8;   // rolling range width / baseline volatility
const POS_ACCUM_MAX      = 0.34;  // range position lower bound
const POS_DIST_MIN       = 0.66;  // range position upper bound
const ROLL_BARS          = 96;
const EMA_PERIOD         = 50;
const ATR_PERIOD         = 14;
const SLOPE_LOOKBACK     = 8;     // bars for the EMA50 slope read
// Compression must be measured against RECENT PAST volatility, not the range
// window's own ATR. If the baseline window <= ROLL_BARS then VolBaseline <= span
// always (all true ranges live inside [rollLow, rollHigh]) => rangeWidth >= 1,
// making the compression branch dead code. A longer baseline (3x ROLL_BARS)
// lets a quiet consolidation register as width < 1.
const VOL_BARS           = ROLL_BARS * 3; // 288 — compression volatility baseline

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
 * Classify the market regime from macro OHLCV candles only.
 *
 * @param {Array<{open:number,high:number,low:number,close:number,volume?:number}>} macroCandles
 * @returns {'TREND'|'CHOP'|'ACCUMULATION'|'DISTRIBUTION'} never null
 */
export function classifyRegimeProxy(macroCandles) {
  // 1. Insufficient candles -> 'CHOP' (never null).
  const candles = Array.isArray(macroCandles) ? macroCandles : [];
  if (candles.length < EMA_PERIOD) return 'CHOP';

  const closes = candles.map((c) => Number(c.close));
  if (closes.some((v) => !Number.isFinite(v))) return 'CHOP';

  // Displacement uses the fast ATR14; compression uses a longer baseline.
  const atr14 = Math.max(wilderATR(candles, ATR_PERIOD), 1e-9);
  const volBaseline = Math.max(wilderATR(candles, Math.min(VOL_BARS, candles.length)), 1e-9);

  // 2. EMA50 slope -> "displacement" = (ema[last] - ema[last-8]) / ATR14.
  const emaNow = ema(closes, EMA_PERIOD);
  const emaPrev = ema(closes.slice(0, closes.length - SLOPE_LOOKBACK), EMA_PERIOD);
  if (emaNow == null || emaPrev == null) return 'CHOP';
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

  // 4. Rules, first match wins.
  if (Math.abs(displacement) >= DISPLACEMENT_TREND) return 'TREND';
  if (rangeWidth <= RANGE_COMPRESSION && rangePos >= POS_DIST_MIN) return 'DISTRIBUTION';
  if (rangeWidth <= RANGE_COMPRESSION && rangePos <= POS_ACCUM_MAX) return 'ACCUMULATION';
  return 'CHOP';
}
