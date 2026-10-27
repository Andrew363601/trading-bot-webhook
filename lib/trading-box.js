// lib/trading-box.js
// 🟢 PUSH AM71 — TRADING-BOX CONTEXT (additive, pure).
//
// Builds a self-describing snapshot of the price's position inside its recent
// macro range, plus rolling VWAP and the nearest order-book walls. The result is
// stamped into trade_logs.params_context.trading_box at entry so the agent (and
// the autopsy) can reason about WHERE in the range the entry sits.
//
// INVISIBLE-FALLBACK DOCTRINE: any missing input (book fetch fails, ATR null,
// candles too short) → { available: false, reason: '<specific>' } with every box
// field null. LOUD absence. NEVER a Coinbase substitution. NEVER a fabricated wall.
//
// The brain prompt needs no change: `summary` is a self-describing human line.

const MIN_MACRO_CANDLES = 5; // below this the swing range is meaningless

/**
 * Largest level within ±1 macro-ATR of price on one side of the book.
 * @param {Array<{price:number,size:number}>} levels
 * @param {number} price
 * @param {number} atr
 * @param {'below'|'above'} side
 * @returns {{price:number,size:number}|null}
 */
function largestWallWithin(levels, price, atr, side) {
  if (!Array.isArray(levels) || !Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return null;
  const band = atr; // ±1 macro-ATR
  const inBand = levels.filter((l) => {
    if (!l || !Number.isFinite(l.price) || !Number.isFinite(l.size) || l.size <= 0) return false;
    if (side === 'below') return l.price <= price && l.price >= price - band;
    return l.price >= price && l.price <= price + band;
  });
  if (inBand.length === 0) return null;
  // Largest-single-level simplification (honest): the representative cluster is
  // the single biggest resting level in the band, NOT a summed cluster.
  return inBand.reduce((m, l) => (l.size > m.size ? l : m), inBand[0]);
}

/**
 * Build the trading-box context. Async because it awaits `fetchBook()`.
 *
 * @param {object} o
 * @param {string} o.venue - canonical venue ('coinbase'|'krakenspot'|'krakenfutures'|'kraken')
 * @param {string} o.product - the venue product/native symbol (for the summary)
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} o.macroCandles
 * @param {number} o.macroAtr - macro-TF ATR (price units)
 * @param {() => Promise<{bids:Array<{price:number,size:number}>,asks:Array<{price:number,size:number}>}>} [o.fetchBook]
 * @param {'LONG'|'SHORT'} [o.direction='LONG'] - which side is "defending"
 * @param {string} [o.macroTf] - macro TF label for the summary
 * @returns {Promise<object>} the box context (available:false on any missing input)
 */
export async function buildTradingBox({ venue, product, macroCandles, macroAtr, fetchBook, direction = 'LONG', macroTf = null } = {}) {
  const unavailable = (reason) => ({
    available: false,
    source: null,
    macro_tf: macroTf,
    range_top: null,
    range_bottom: null,
    position_pct: null,
    width_atr: null,
    vwap: null,
    vwap_dist_atr: null,
    walls: { defending: null, opposing: null },
    too_narrow_hint: null,
    summary: null,
    reason
  });

  // ── Input validation (LOUD absence, never a substitution) ──
  if (!Array.isArray(macroCandles) || macroCandles.length < MIN_MACRO_CANDLES) {
    return unavailable(`macro candles too short (${Array.isArray(macroCandles) ? macroCandles.length : 0} < ${MIN_MACRO_CANDLES})`);
  }
  if (!Number.isFinite(macroAtr) || macroAtr <= 0) {
    return unavailable('macro ATR unavailable');
  }

  const highs = macroCandles.map((c) => Number(c?.high)).filter(Number.isFinite);
  const lows = macroCandles.map((c) => Number(c?.low)).filter(Number.isFinite);
  if (highs.length === 0 || lows.length === 0) {
    return unavailable('macro candles carry no finite high/low');
  }
  const rangeTop = Math.max(...highs);
  const rangeBottom = Math.min(...lows);
  const rangeWidth = rangeTop - rangeBottom;
  if (!(rangeWidth > 0)) {
    return unavailable('macro range has zero width');
  }

  const lastClose = Number(macroCandles[macroCandles.length - 1]?.close);
  if (!Number.isFinite(lastClose)) {
    return unavailable('last macro close is not finite');
  }

  const positionPct = ((lastClose - rangeBottom) / rangeWidth) * 100;
  const widthAtr = rangeWidth / macroAtr;
  const tooNarrowHint = widthAtr < 1.0;

  // ── Rolling VWAP over the provided macro candles (stdlib accumulation) ──
  let pvSum = 0;
  let volSum = 0;
  for (const c of macroCandles) {
    const h = Number(c?.high), l = Number(c?.low), cl = Number(c?.close), v = Number(c?.volume);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl) || !Number.isFinite(v) || v <= 0) continue;
    const typical = (h + l + cl) / 3;
    pvSum += typical * v;
    volSum += v;
  }
  const vwap = volSum > 0 ? pvSum / volSum : null;
  const vwapDistAtr = vwap != null ? (lastClose - vwap) / macroAtr : null;

  // ── Walls from the venue book (best-effort; failure degrades the WALLS only) ──
  let defending = null;
  let opposing = null;
  let bookNote = '';
  if (typeof fetchBook === 'function') {
    try {
      const book = await fetchBook();
      const bids = Array.isArray(book?.bids) ? book.bids : [];
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      // LONG: defending = bid side (below), opposing = ask side (above).
      // SHORT: defending = ask side (above), opposing = bid side (below).
      const defSide = direction === 'SHORT' ? 'above' : 'below';
      const oppSide = direction === 'SHORT' ? 'below' : 'above';
      defending = largestWallWithin(bids, lastClose, macroAtr, defSide) || largestWallWithin(asks, lastClose, macroAtr, defSide);
      opposing = largestWallWithin(asks, lastClose, macroAtr, oppSide) || largestWallWithin(bids, lastClose, macroAtr, oppSide);
    } catch (e) {
      bookNote = ` (book unavailable: ${e.message})`;
    }
  } else {
    bookNote = ' (no book door)';
  }

  // ── Self-describing summary ──
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
  const wallStr = (w) => (w ? `${fmt(w.price)} (${(w.size / 1000).toFixed(1)}k)` : 'none');
  const vwapStr = vwapDistAtr != null ? `${vwapDistAtr >= 0 ? '+' : ''}${vwapDistAtr.toFixed(1)} ATR ${vwapDistAtr >= 0 ? 'above' : 'below'} rolling VWAP` : 'VWAP unavailable';
  const summary =
    `Trading box ${fmt(rangeBottom)}–${fmt(rangeTop)} (width ${widthAtr.toFixed(1)}× macro ATR), ` +
    `price at ${positionPct.toFixed(0)}% from bottom, ${vwapStr}; ` +
    `nearest defending wall ${wallStr(defending)}, nearest opposing wall ${wallStr(opposing)}` +
    (tooNarrowHint ? ' [TOO NARROW: width < 1× ATR]' : '') + bookNote;

  return {
    available: true,
    source: venue || null,
    macro_tf: macroTf,
    range_top: rangeTop,
    range_bottom: rangeBottom,
    position_pct: positionPct,
    width_atr: widthAtr,
    vwap,
    vwap_dist_atr: vwapDistAtr,
    walls: { defending, opposing },
    too_narrow_hint: tooNarrowHint,
    summary,
    reason: null
  };
}
