// lib/coinglass-api.js
//
// Shared Coinglass v4 helpers. Paths/params verified against STARTUP plan 2026-09-09.
//
// Key constraints encoded here:
//   - STARTUP plan interval floor is 30m — 1m/5m/15m return 400 "interval not
//     available for plan". cgInterval() floors anything sub-30m up to 30m.
//   - Exchange-specific history endpoints need the INSTRUMENT (BTCUSDT), while
//     aggregate/index endpoints need the BASE ticker (BTC). cgInstrument() and
//     cgBase() normalize either direction.

export const CG_BASE = 'https://open-api-v4.coinglass.com/';

export const CG_INTERVALS = ['30m', '1h', '2h', '4h', '6h', '12h', '1d'];

const CG_INTERVAL_MINUTES = {
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
};

/**
 * Normalize any requested interval to one the STARTUP plan supports.
 * Sub-30m requests are floored to 30m; in-between values snap up to the
 * nearest available tier (e.g. '45m' -> '1h', '90m' -> '2h').
 */
export function cgInterval(iv, def = '30m') {
  if (!iv) return def;
  const s = String(iv).toLowerCase().trim();
  if (CG_INTERVALS.includes(s)) return s;
  const mins = s.endsWith('m') ? parseInt(s, 10)
    : s.endsWith('h') ? parseInt(s, 10) * 60
    : s.endsWith('d') ? parseInt(s, 10) * 1440
    : Number.isFinite(Number(s)) ? Number(s) // bare minute count e.g. "60"
    : NaN;
  if (!Number.isFinite(mins) || mins <= 0) return def;
  for (const t of CG_INTERVALS) {
    if (CG_INTERVAL_MINUTES[t] >= mins) return t;
  }
  return '1d';
}

/**
 * Instrument form for exchange-specific history endpoints: "BTCUSDT".
 */
export function cgInstrument(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

/**
 * Base ticker form for aggregate/index endpoints: "BTC".
 * Strips USDT/USDC/USD quote suffixes the gateway may have appended.
 */
export function cgBase(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  return s.replace(/(USDT|USDC|USD)$/i, '') || s;
}

/**
 * GET a Coinglass v4 endpoint. Throws on non-zero business code or missing
 * data; callers keep their own try/catch to preserve the {status:'error'}
 * contract expected by the MCP gateway and the UI indicator route.
 */
export async function cgGet(path) {
  const res = await fetch(`${CG_BASE}${path}`, {
    headers: { accept: 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (String(body.code) !== '0' || body.data === undefined) {
    throw new Error(body.msg || body.message || `Coinglass HTTP ${res.status}`);
  }
  return body.data;
}
