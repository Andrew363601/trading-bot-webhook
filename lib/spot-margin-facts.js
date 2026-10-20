// lib/spot-margin-facts.js
// 🟢 AM69 — SPOT × MARGIN FACTS: the SINGLE SOURCE OF TRUTH for the Kraken SPOT
// margin UX + its server mirrors.
//
// DOCTRINE — "the form is generated from the venue's facts": the user can only
// enter what the venue will actually accept; everything else is hidden or disabled
// with a plain-language reason. The UI and the server read the SAME functions, so a
// stale client can never produce a confusing rejection and a wording can never drift
// (one string, two call sites — the computeNotional precedent, applied to validation).
//
// The `facts` object is a krakenspot product row from /api/available-assets
// (handleKrakenSpot): { id, base, quote, native_symbol, lot_decimals, pair_decimals,
// ordermin, costmin, tick_size, margin, leverage_buy[], leverage_sell[], ... }.
// `margin === false` ⇒ the pair is NOT margin-eligible (EUR quote / TX restriction).
//
// Pure + dependency-free (Intl only) so it can be imported by the client bundle, by
// API routes, and dynamic-imported by the gate (behavioral vector).

// ── Labels + disclosure copy (ONE wording, zero drift) ─────────────────────
export const BORROWING_LABEL = 'Borrowing';
export const CASH_CHIP_LABEL = 'Cash';
export const INTEREST_DISCLOSURE = 'Interest accrues on borrowed funds.';

// The EUR/TX line shown INSTEAD of chips when a pair is not margin-eligible.
export const SPOT_MARGIN_EUR_ERROR =
  "Margin isn't available for EUR pairs on your account (Texas restriction) — cash orders only.";

// Borrowing chips are DIRECTION-AGNOSTIC (the strategy's side is decided by the brain
// at runtime). Selling inside a long = closing; borrowing = a margin position.
export function borrowingChipClass(active) {
  const base =
    'px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-colors';
  return active
    ? `${base} border-indigo-500 bg-indigo-500/20 text-indigo-200`
    : `${base} border-white/10 bg-slate-950 text-slate-400 hover:border-white/20 hover:text-slate-200`;
}

// ── Fact derivations ───────────────────────────────────────────────────────
function toNumericLevels(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => parseFloat(x))
    .filter((n) => Number.isFinite(n) && n > 1); // 1 = cash (no borrow); drop it
}

// Margin is available unless the venue explicitly says it is not (EUR quote).
export function isMarginEligible(facts) {
  return !!facts && facts.margin !== false;
}

// The borrowing levels the user may pick. DIRECTION-AGNOSTIC: use the INTERSECTION
// of leverage_buy ∩ leverage_sell when both diverge (safe for EITHER side), else
// whichever array exists. Sorted ascending. Empty ⇒ cash-only (EUR/none).
export function deriveBorrowingLevels(facts) {
  if (!isMarginEligible(facts)) return [];
  const buy = toNumericLevels(facts.leverage_buy);
  const sell = toNumericLevels(facts.leverage_sell);
  let levels;
  if (buy.length && sell.length) {
    const sellSet = new Set(sell);
    levels = buy.filter((n) => sellSet.has(n));
  } else {
    levels = buy.length ? buy : sell;
  }
  return Array.from(new Set(levels)).sort((a, b) => a - b);
}

export function maxBorrowingLevel(facts) {
  const levels = deriveBorrowingLevels(facts);
  return levels.length ? levels[levels.length - 1] : null;
}

// Side-aware max — used by the LANE (execution knows the side). `side` may be
// 'buy'/'long' (entry long) or 'sell'/'short' (entry short).
export function maxLeverageForSide(facts, side) {
  if (!isMarginEligible(facts)) return null;
  const isSell = side === 'sell' || side === 'SELL' || side === 'short' || side === 'SHORT';
  const arr = toNumericLevels(isSell ? facts.leverage_sell : facts.leverage_buy);
  if (arr.length) return Math.max(...arr);
  // Fall back to the other side if the venue only published one array.
  const other = toNumericLevels(isSell ? facts.leverage_buy : facts.leverage_sell);
  return other.length ? Math.max(...other) : null;
}

// ── Plain-language error strings (reused VERBATIM by deploy + subscribe + lane) ──
export function spotMinOrderError({ symbol, ordermin, base, qty }) {
  return `Kraken Spot minimum order for ${symbol} is ${ordermin} ${base} (requested ${qty}).`;
}
export function spotMinCostError({ symbol, costmin, quote, notional }) {
  return `Kraken Spot minimum cost for ${symbol} is ${costmin} ${quote} (requested ≈ ${notional}).`;
}
export function spotLeverageError({ leverage, max }) {
  return `Leverage ${leverage}× exceeds the venue max ${max}× for this pair.`;
}

// ── Validation (the server mirrors the UI EXACTLY via this one function) ──────
// SIDE-AWARE: pass `side` at the LANE (execution) to enforce leverage_buy/sell;
// omit `side` at DEPLOY (no order side exists yet) to enforce the INTERSECTION.
// Returns { ok, error } — error is the exact 400 body string.
export function validateKrakenSpotOrder({ facts, leverage, qty, side = null, symbol = '', notional = null }) {
  if (!facts) return { ok: true, error: null };
  const lev = parseFloat(leverage);
  const wantsMargin = Number.isFinite(lev) && lev > 1;

  // Margin requested on a non-eligible (EUR/TX) pair.
  if (facts.margin === false && wantsMargin) {
    return { ok: false, error: SPOT_MARGIN_EUR_ERROR };
  }

  // Leverage max (side-aware if a side is known, else the safe intersection max).
  if (wantsMargin) {
    const max = side ? maxLeverageForSide(facts, side) : maxBorrowingLevel(facts);
    if (max == null || lev > max) {
      return { ok: false, error: spotLeverageError({ leverage: lev, max: max == null ? lev : max }) };
    }
  }

  // Qty floor (min base volume).
  const q = parseFloat(qty);
  const min = facts.ordermin != null ? parseFloat(facts.ordermin) : null;
  if (Number.isFinite(q) && q > 0 && min != null && Number.isFinite(min) && q < min) {
    return { ok: false, error: spotMinOrderError({ symbol, ordermin: facts.ordermin, base: facts.base, qty: q }) };
  }

  // Notional floor (min cost) — only checked when the notional is supplied.
  const n = notional != null ? parseFloat(notional) : NaN;
  const cmin = facts.costmin != null ? parseFloat(facts.costmin) : null;
  if (Number.isFinite(n) && n > 0 && cmin != null && Number.isFinite(cmin) && n < cmin) {
    return { ok: false, error: spotMinCostError({ symbol, costmin: facts.costmin, quote: facts.quote, notional: n.toFixed(2) }) };
  }

  return { ok: true, error: null };
}

// ── UI helpers ─────────────────────────────────────────────────────────────
// Lift a sub-minimum qty to the venue floor on blur. Returns the (possibly) new
// value string + a flag so the caller can toast/hint.
export function clampSpotQtyToOrdermin(qty, facts) {
  const min = facts && facts.ordermin != null ? parseFloat(facts.ordermin) : null;
  const q = parseFloat(qty);
  if (Number.isFinite(q) && min != null && Number.isFinite(min) && q > 0 && q < min) {
    return { value: String(min), clamped: true, ordermin: min };
  }
  return { value: qty, clamped: false, ordermin: Number.isFinite(min) ? min : null };
}

export function spotQtyMinHint(facts) {
  if (!facts || facts.ordermin == null) return null;
  return `min ${facts.ordermin} ${facts.base || ''}`.trim();
}

// Snap a typed price to the pair's decimal precision (Kraken rejects extra digits).
export function snapSpotPriceToDecimals(price, pairDecimals) {
  const p = parseFloat(price);
  const d = Number.isInteger(pairDecimals) ? pairDecimals : parseInt(pairDecimals, 10);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d < 0) return price;
  return parseFloat(p.toFixed(d));
}

const usd = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);

// Notional preview split. Long: cash = notional/lev, borrowed = rest. Short: the
// FULL position is borrowed (you borrow base, sell it, buy back to close). Returns
// null when there is nothing to say (cash trade / no notional).
export function cashBorrowedPreview({ notional, leverage, side = 'long', base = '' }) {
  const n = parseFloat(notional);
  const lev = parseFloat(leverage);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(lev) || lev <= 1) return null;
  const isShort = side === 'short' || side === 'SHORT' || side === 'sell' || side === 'SELL';
  if (isShort) {
    return `≈ ${usd(n)} short · borrowed ${usd(n)} of ${base || 'the base asset'} (${lev}×) · buy-back closes it`;
  }
  const cash = n / lev;
  return `≈ ${usd(n)} position · your cash ${usd(cash)} · borrowed ${usd(n - cash)} (${lev}×)`;
}
