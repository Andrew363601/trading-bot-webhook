// AM58 C4 — backtester cooldown default parity with the sniper's TF-scaled default.
//
// Proves: omitting veto_cooldown_minutes now yields the SAME result as passing
// the TF-scaled default explicitly (FIVE_MINUTE -> min(max(3*5,5),720) = 15 min),
// and differs from the old default of 0.
//
// Run: node scripts/am58-cooldown-parity-check.mjs
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

const common = { code, product: 'BTC-USD', macro_tf: 'ONE_HOUR', trigger_tf: 'FIVE_MINUTE', start: t0, end: t0 + N * 300, syntheticTriggerCandles: trigger, syntheticMacroCandles: macro };
const base = { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005 };

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

const omitted = await runBacktest({ ...common, parameters: { ...base } });
const explicit15 = await runBacktest({ ...common, parameters: { ...base, veto_cooldown_minutes: 15 } });

check('omitted == explicit 15min (TF-scaled default)', omitted.trades.length === explicit15.trades.length, `${omitted.trades.length} vs ${explicit15.trades.length}`);
check('omitted trades byte-equal to explicit 15min', JSON.stringify(omitted.trades) === JSON.stringify(explicit15.trades));

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
