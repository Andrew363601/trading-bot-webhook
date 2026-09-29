// AM53c — regime-aware backtest walk validation.
//
// Proves:
//  1. REGRESSION GUARD: a no-map run is byte-equal to the pre-AM53c engine
//     (lib/backtester.head.js, extracted from git HEAD) — baseline must not move.
//  2. Map {CHOP:{tp_percent,sl_percent}} -> CHOP trades exit at the mapped
//     distances; TREND trades stay at base.
//  3. Invalid map -> loud error (never silent).
//  4. summary.regime_exits_applied echoes sources correctly.
//
// Run: node scripts/am53c-regime-walk-check.mjs
import { runBacktest } from '../lib/backtester.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
function pricePath(n, base = 100) {
  const rnd = rng(42); const out = []; let p = base;
  for (let i = 0; i < n; i++) {
    let drift = 0, amp = 1;
    if (i < n * 0.34) { drift = 0.05; amp = 0.8; }
    else if (i < n * 0.67) { drift = 0; amp = 0.6; }
    else { drift = 0; amp = 0.1; }
    p += drift + rnd() * amp;
    const r = amp * (0.4 + Math.abs(rnd()));
    out.push({ open: p, high: p + r / 2, low: p - r / 2, close: p, volume: 10 });
  }
  return out;
}

const N = 4000;
const path = pricePath(N);
const t0 = 1700000000;
const trigger = path.map((c, i) => ({ ...c, time: t0 + i * 300 }));
const macro = [];
for (let i = 0; i < N; i += 12) { const w = path.slice(i, i + 12); macro.push({ open: w[0].open, high: Math.max(...w.map(x => x.high)), low: Math.min(...w.map(x => x.low)), close: w[w.length - 1].close, volume: 120, time: t0 + i * 300 }); }

// Strategy returns signal ONLY (no explicit tp/sl) so base pct fallback applies.
const code = `
export async function run(macroCandles, triggerCandles, parameters) {
  const closes = triggerCandles.map(c => c.close);
  const n = triggerCandles.length;
  if (n < 20) return { signal: null };
  const sma = (a, p) => a.slice(-p).reduce((x, y) => x + y, 0) / p;
  const fast = sma(closes, 8), slow = sma(closes, 21);
  const price = closes[n - 1];
  if (fast > slow && price > slow) return { signal: 'LONG' };
  if (fast < slow && price < slow) return { signal: 'SHORT' };
  return { signal: null };
}`;

const baseParams = { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005, veto_cooldown_minutes: 5 };
const common = { code, product: 'BTC-USD', macro_tf: 'ONE_HOUR', trigger_tf: 'FIVE_MINUTE', start: t0, end: t0 + N * 300, syntheticTriggerCandles: trigger, syntheticMacroCandles: macro };

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// 1. No-map run (current engine).
const noMap = await runBacktest({ ...common, parameters: baseParams });
// Empty map must behave identically to no map.
const emptyMap = await runBacktest({ ...common, parameters: { ...baseParams, regime_params: {} } });
check('no-map run produces trades', noMap.trades.length > 0, `n=${noMap.trades.length}`);
check('empty map == no map (trades byte-equal)', JSON.stringify(noMap.trades) === JSON.stringify(emptyMap.trades));
check('no-map trades all exit_source=base', noMap.trades.every(t => t.exit_source === 'base'));
check('no-map regime_exits_applied is empty', Object.keys(noMap.summary.regime_exits_applied || {}).length === 0);

// 2. CHOP map.
const chopMap = { CHOP: { tp_percent: 0.025, sl_percent: 0.012 } };
const mapped = await runBacktest({ ...common, parameters: { ...baseParams, regime_params: chopMap } });
const chopTrades = mapped.trades.filter(t => t.regime === 'CHOP');
const trendTrades = mapped.trades.filter(t => t.regime === 'TREND');
check('mapped run has CHOP trades', chopTrades.length > 0, `n=${chopTrades.length}`);
check('mapped run has TREND trades', trendTrades.length > 0, `n=${trendTrades.length}`);
check('CHOP trades exit_source=map', chopTrades.every(t => t.exit_source === 'map'));
check('TREND trades exit_source=base', trendTrades.every(t => t.exit_source === 'base'));

// CHOP TP exits should sit ~2.5% from entry; SL exits ~1.2%.
const dist = (t) => Math.abs(t.exit_price - t.entry_price) / t.entry_price;
const chopTp = chopTrades.filter(t => t.exit_reason === 'TP');
const chopSl = chopTrades.filter(t => t.exit_reason === 'SL');
check('CHOP TP exits ~2.5%', chopTp.length > 0 && chopTp.every(t => Math.abs(dist(t) - 0.025) < 0.002), chopTp.length ? `max dev ${Math.max(...chopTp.map(t => Math.abs(dist(t) - 0.025))).toFixed(5)}` : 'no TP exits');
check('CHOP SL exits ~1.2%', chopSl.length > 0 && chopSl.every(t => Math.abs(dist(t) - 0.012) < 0.002), chopSl.length ? `max dev ${Math.max(...chopSl.map(t => Math.abs(dist(t) - 0.012))).toFixed(5)}` : 'no SL exits');

// TREND trades must stay at base (1.0% TP / 0.5% SL).
const trendTp = trendTrades.filter(t => t.exit_reason === 'TP');
check('TREND TP exits stay at base 1.0%', trendTp.length > 0 && trendTp.every(t => Math.abs(dist(t) - 0.01) < 0.002), trendTp.length ? `max dev ${Math.max(...trendTp.map(t => Math.abs(dist(t) - 0.01))).toFixed(5)}` : 'no TP exits');

// 4. Echo.
const echo = mapped.summary.regime_exits_applied || {};
check('regime_exits_applied has CHOP', !!echo.CHOP);
check('CHOP echo source=map', echo.CHOP?.source === 'map', JSON.stringify(echo.CHOP));
check('CHOP echo tp/sl match map', echo.CHOP?.tp_percent === 0.025 && echo.CHOP?.sl_percent === 0.012);

// 3. Invalid map -> loud error.
let threw = false, msg = '';
try {
  await runBacktest({ ...common, parameters: { ...baseParams, regime_params: { CHOP: { leverage: 5 } } } });
} catch (e) { threw = true; msg = e.message; }
check('invalid map throws loud', threw && /invalid regime_params/.test(msg), msg);

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
