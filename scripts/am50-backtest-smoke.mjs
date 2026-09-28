// AM50 smoke: drive runBacktest end-to-end with synthetic candles + a trivial
// strategy, and assert every trade has a regime + summary has 4 buckets + version.
import { runBacktest } from '../lib/backtester.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }

// Build a mixed-regime price path: trend up -> chop -> banded consolidation.
function pricePath(n, base = 100) {
  const rnd = rng(42); const out = []; let p = base;
  for (let i = 0; i < n; i++) {
    let drift = 0, amp = 1;
    if (i < n * 0.34) { drift = 0.05; amp = 0.8; }         // TREND-ish
    else if (i < n * 0.67) { drift = 0; amp = 0.6; }        // CHOP
    else { drift = 0; amp = 0.1; }                          // banded
    p += drift + rnd() * amp;
    const r = amp * (0.4 + Math.abs(rnd()));
    out.push({ open: p, high: p + r / 2, low: p - r / 2, close: p, volume: 10 });
  }
  return out;
}

const N = 4000;
const path = pricePath(N);
const t0 = 1700000000;
const trigger = path.map((c, i) => ({ ...c, time: t0 + i * 300 }));            // 5m bars
const macro = [];                                                              // 1h bars (every 12th)
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

const res = await runBacktest({
  code,
  parameters: { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005, veto_cooldown_minutes: 5 },
  product: 'BTC-USD',
  macro_tf: 'ONE_HOUR',
  trigger_tf: 'FIVE_MINUTE',
  start: t0,
  end: t0 + N * 300,
  syntheticTriggerCandles: trigger,
  syntheticMacroCandles: macro
});

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

const trades = res.trades || [];
check('trades produced', trades.length > 0, `n=${trades.length}`);
check('every trade has a non-null regime', trades.every(t => ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'].includes(t.regime)), JSON.stringify([...new Set(trades.map(t => t.regime))]));
check('summary has regime_proxy_version', res.summary.regime_proxy_version === 'proxy_v1', res.summary.regime_proxy_version);
check('summary has all four buckets', ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'].every(r => res.summary.regime_breakdown && r in res.summary.regime_breakdown), Object.keys(res.summary.regime_breakdown || {}).join(','));
const sumN = Object.values(res.summary.regime_breakdown).reduce((a, b) => a + b.n, 0);
check('bucket n sums to total_trades', sumN === trades.length, `${sumN} vs ${trades.length}`);
const zeroN = Object.entries(res.summary.regime_breakdown).filter(([, b]) => b.n === 0);
check('zero-n buckets have null win_rate', zeroN.every(([, b]) => b.win_rate === null), zeroN.map(([k]) => k).join(','));

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
console.log('regime_breakdown:', JSON.stringify(res.summary.regime_breakdown));
process.exit(pass === results.length ? 0 : 1);
