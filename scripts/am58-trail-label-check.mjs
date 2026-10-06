// AM58 C1 — trail exit-label by stop level + BE floor.
//
// Proves the L206 flag-chain bug is fixed: a stop hit is labeled by the STOP
// LEVEL at hit time ('SL' | 'TRIPWIRE' | 'TRAIL'), not by the trailing flag
// (which flips on the first bar roe >= activation even if the ratchet never
// raised the stop).
//
// Run: node scripts/am58-trail-label-check.mjs
import { runBacktest } from '../lib/backtester.js';

const T0 = 1700000000;
const STEP = 300;

// Build candles from {high, low, close} specs; open = previous close.
function mkCandles(specs) {
  const out = [];
  let prevClose = specs[0].close;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    out.push({ time: T0 + i * STEP, open: prevClose, high: s.high, low: s.low, close: s.close, volume: 10 });
    prevClose = s.close;
  }
  return out;
}

// Flat lead-in so the strategy (LONG when >= 20 bars) enters at bar 19 @ 100.
function leadIn(n = 20) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ high: 100.1, low: 99.9, close: 100 });
  return out;
}

const code = `
export async function run(macroCandles, triggerCandles, parameters) {
  if (triggerCandles.length < 20) return { signal: null };
  return { signal: 'LONG' };
}`;

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

async function run(specs, parameters) {
  const candles = mkCandles(specs);
  return runBacktest({
    code, product: 'BTC-USD', macro_tf: 'ONE_HOUR', trigger_tf: 'FIVE_MINUTE',
    start: T0, end: T0 + specs.length * STEP,
    syntheticTriggerCandles: candles, syntheticMacroCandles: candles,
    parameters
  });
}

// ── (i) bar touches +6% intrabar but CLOSES at entry*0.988 -> 'SL', pnl < 0 ──
{
  const specs = [...leadIn(), { high: 106, low: 98.8, close: 98.8 }];
  const r = await run(specs, { qty: 1000, leverage: 10, sl_percent: 0.012, tripwire_percent: 0.05, trail_step_percent: 0.02 });
  const t = r.trades[0];
  check('(i) exit_reason SL (not TRAIL)', t?.exit_reason === 'SL', `got ${t?.exit_reason}`);
  check('(i) pnl negative', (t?.pnl_usd ?? 0) < 0, `pnl ${t?.pnl_usd}`);
}

// ── (ii) ratcheted stop hit above BE -> 'TRAIL', pnl > 0 ──
{
  const specs = [...leadIn(), { high: 100.6, low: 100.5, close: 100.6 }, { high: 100.4, low: 100.3, close: 100.35 }];
  const r = await run(specs, { qty: 1000, leverage: 10, sl_percent: 0.012, tripwire_percent: 0.05, trail_step_percent: 0.02 });
  const t = r.trades[0];
  check('(ii) exit_reason TRAIL', t?.exit_reason === 'TRAIL', `got ${t?.exit_reason}`);
  check('(ii) exit above entry', (t?.exit_price ?? 0) > 100, `exit ${t?.exit_price}`);
  check('(ii) pnl positive', (t?.pnl_usd ?? 0) > 0, `pnl ${t?.pnl_usd}`);
}

// ── (iii) tripwire=0, trail_step 0.02, bar closes +1% ROE -> stop >= 100.1, WIN ──
{
  const specs = [...leadIn(), { high: 101, low: 100.9, close: 101 }, { high: 100.8, low: 100.7, close: 100.75 }];
  const r = await run(specs, { qty: 1000, leverage: 10, sl_percent: 0.012, tripwire_percent: 0, trail_step_percent: 0.02 });
  const t = r.trades[0];
  check('(iii) exit_reason TRAIL', t?.exit_reason === 'TRAIL', `got ${t?.exit_reason}`);
  check('(iii) stop >= 100.1 (BE floor)', (t?.exit_price ?? 0) >= 100.1, `exit ${t?.exit_price}`);
  check('(iii) pnl positive (WIN)', (t?.pnl_usd ?? 0) > 0, `pnl ${t?.pnl_usd}`);
}

// ── (iv) FLAG-CHAIN BUG DEMO: trailing flips true but ratchet never raises the
//        stop above BE (trail_step large) -> hit is a TRIPWIRE, not a TRAIL. ──
{
  const specs = [...leadIn(), { high: 100.6, low: 100.5, close: 100.6 }, { high: 100.2, low: 100.0, close: 100.05 }];
  const r = await run(specs, { qty: 1000, leverage: 10, sl_percent: 0.012, tripwire_percent: 0.05, trail_step_percent: 0.06 });
  const t = r.trades[0];
  check('(iv) exit_reason TRIPWIRE (not TRAIL)', t?.exit_reason === 'TRIPWIRE', `got ${t?.exit_reason}`);
  check('(iv) exit at BE ~100.1', Math.abs((t?.exit_price ?? 0) - 100.1) < 0.01, `exit ${t?.exit_price}`);
}

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
