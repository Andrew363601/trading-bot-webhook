// lib/order-readiness.js
// 🟢 AM73 — ORDER-READINESS: the SINGLE SOURCE OF TRUTH for the cash/margin mode
// badge and the ORDER-READINESS strip (balance / key perms / margin mode / last
// venue verdict). Pure + dependency-free so it can be imported by the client
// bundle (strategy card + scanner), by the probe route, and dynamic-imported by
// the gate (behavioral vector) — the spot-margin-facts precedent.
//
// DOCTRINE — "the card tells you what's blocking before you deploy": the badge is
// computed from the SAME rule the LANE uses (leverage > 1 && pair margin-eligible),
// so the UI can never disagree with execution. The readiness rows are honest-absent
// ('—' / 'unverified') when a fact is unknown — never a fabricated green check.

// ── Mode badge ─────────────────────────────────────────────────────────────
// The lane's rule (lib/execute-trade-mcp.js KSPOT lane):
//   ksLeverage = (krakenSpotProduct.margin !== false && leverage > 1) ? … : null
// i.e. MARGIN only when the pair is margin-eligible AND leverage > 1; else CASH.
export function deriveOrderMode({ leverage, marginEligible } = {}) {
  const lev = parseFloat(leverage);
  const wantsMargin = Number.isFinite(lev) && lev > 1;
  const eligible = marginEligible !== false; // undefined ⇒ assume eligible (honest default)
  if (wantsMargin && eligible) {
    return { mode: 'MARGIN', leverage: lev, label: `MARGIN ×${lev}` };
  }
  return { mode: 'CASH', leverage: Number.isFinite(lev) ? lev : 1, label: 'CASH order' };
}

// ── Readiness rows ─────────────────────────────────────────────────────────
// Build the ORDER-READINESS section as structured rows { check, ok, detail }.
// `ok` is true | false | null (null = unknown / unverified — honest-absent).
// Inputs are all optional; a missing input yields an honest-absent row.
//
//   balance      — { equity_usd, available_margin, margin_level } | null
//   keyPerms     — { query: bool, orders: bool } | null
//   mode         — the deriveOrderMode() result (or { mode, label })
//   lastVerdict  — { ok, detail } | null  (the last venue verdict for this asset)
//   marginVerified — bool | null  (ECP honesty: null ⇒ unverified until first order)
export function readinessRows({ balance = null, keyPerms = null, mode = null, lastVerdict = null, marginVerified = null } = {}) {
  const rows = [];
  const usd = (v) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);

  // 1. Balance (real, venue).
  if (balance && balance.equity_usd != null && Number.isFinite(parseFloat(balance.equity_usd))) {
    rows.push({ check: 'Balance', ok: parseFloat(balance.equity_usd) > 0, detail: usd(parseFloat(balance.equity_usd)) });
  } else {
    rows.push({ check: 'Balance', ok: null, detail: '—' });
  }

  // 2. Key perms (query / orders).
  if (keyPerms && (keyPerms.query != null || keyPerms.orders != null)) {
    const q = keyPerms.query === true ? 'query ✓' : keyPerms.query === false ? 'query ✗' : 'query —';
    const o = keyPerms.orders === true ? 'orders ✓' : keyPerms.orders === false ? 'orders ✗' : 'orders —';
    rows.push({ check: 'Key perms', ok: keyPerms.query === true && keyPerms.orders === true, detail: `${q} / ${o}` });
  } else {
    rows.push({ check: 'Key perms', ok: null, detail: '—' });
  }

  // 3. Margin mode (cash/margin per the badge).
  if (mode && mode.mode) {
    rows.push({ check: 'Margin mode', ok: true, detail: mode.label || mode.mode });
  } else {
    rows.push({ check: 'Margin mode', ok: null, detail: '—' });
  }

  // 4. Margin eligibility (ECP honesty rule). Only meaningful for a MARGIN order.
  if (mode && mode.mode === 'MARGIN') {
    if (marginVerified === true) {
      rows.push({ check: 'Margin eligibility', ok: true, detail: 'verified' });
    } else if (marginVerified === false) {
      rows.push({ check: 'Margin eligibility', ok: false, detail: 'NOT ENABLED on this account' });
    } else {
      // Kraken's validate does NOT gate account eligibility — never a green check.
      rows.push({ check: 'Margin eligibility', ok: null, detail: 'unverified until first order' });
    }
  }

  // 5. Last venue verdict.
  if (lastVerdict && lastVerdict.detail) {
    rows.push({ check: 'Last venue verdict', ok: lastVerdict.ok === true ? true : lastVerdict.ok === false ? false : null, detail: lastVerdict.detail });
  } else {
    rows.push({ check: 'Last venue verdict', ok: null, detail: 'none yet' });
  }

  return rows;
}

// ── Reject classification (KSPOT lane) ─────────────────────────────────────
// Classify a Kraken SPOT AddOrder rejectReason into an actionable status + copy.
// Kraken's error array carries the truth (e.g. 'EOrder:Insufficient funds',
// 'EGeneral:Permission denied', Non-ECP margin rejections). Returns
// { status, title, message } — the lane writes the veto row + Discord + log.
export function classifyKrakenSpotReject(rejectReason, { asset = '', leverage = null } = {}) {
  const hay = String(rejectReason || '').toLowerCase();
  const isMargin = Number.isFinite(parseFloat(leverage)) && parseFloat(leverage) > 1;

  // Non-ECP / margin-not-eligible: Kraken rejects a MARGIN order on a US account
  // that has not enabled margin trading (ECP status via Kraken Derivatives US).
  if (isMargin && (hay.includes('non-ecp') || hay.includes('ecp') || hay.includes('margin') || hay.includes('permission'))) {
    return {
      status: 'margin_not_eligible',
      title: `🚫 Kraken rejected a MARGIN order on ${asset}`,
      message: `Kraken rejected a MARGIN order on ${asset} — US spot margin requires margin trading enabled on your Kraken account (ECP status via Kraken Derivatives US). Enable margin in Kraken settings, or set Leverage 1× for CASH mode.`,
    };
  }

  // Insufficient funds.
  if (hay.includes('insufficient') || hay.includes('funds') || hay.includes('balance')) {
    return {
      status: 'insufficient_funds',
      title: `🚫 Kraken rejected the order on ${asset} — insufficient funds`,
      message: `Kraken rejected the order on ${asset} — insufficient funds. Fund the Kraken account or run PAPER mode.`,
    };
  }

  // Everything else — keep the generic entry_rejected status but still surface it.
  return {
    status: 'entry_rejected',
    title: `🚫 Kraken Spot Order Rejected — ${asset}`,
    message: `Kraken Spot rejected the entry: ${rejectReason}`,
  };
}
