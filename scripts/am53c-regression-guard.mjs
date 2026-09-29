// AM53c regression guard: a no-map run must be byte-equal to the pre-AM53c
// engine (extracted from git HEAD at runtime). Proves the per-position
// refactor did not move the baseline.
//
// Run: node scripts/am53c-regression-guard.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import { runBacktest as runNew } from '../lib/backtester.js';

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const headFile = nodePath.join(here, '..', 'lib', '__backtester.head.tmp.mjs');
let runOld;
try {
  const src = execFileSync('git', ['show', 'HEAD:lib/backtester.js'], { cwd: nodePath.join(here, '..'), encoding: 'utf8' });
  writeFileSync(headFile, src);
  ({ runBacktest: runOld } = await import('../lib/__backtester.head.tmp.mjs'));
} catch (e) {
  console.error('[AM53c guard] could not extract HEAD backtester:', e.message);
  process.exit(1);
}

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
const parameters = { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005, veto_cooldown_minutes: 5 };

const oldRes = await runOld({ ...common, parameters });
const newRes = await runNew({ ...common, parameters });

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// Compare trades ignoring the NEW exit_source field (additive).
const strip = (t) => { const { exit_source, ...rest } = t; return rest; };
check('trade count equal', oldRes.trades.length === newRes.trades.length, `${oldRes.trades.length} vs ${newRes.trades.length}`);
check('trades byte-equal (ignoring additive exit_source)', JSON.stringify(oldRes.trades.map(strip)) === JSON.stringify(newRes.trades.map(strip)));
check('equity_curve byte-equal', JSON.stringify(oldRes.equity_curve) === JSON.stringify(newRes.equity_curve));
const stripSummary = (s) => { const { regime_exits_applied, ...rest } = s; return rest; };
check('summary byte-equal (ignoring additive regime_exits_applied)', JSON.stringify(stripSummary(oldRes.summary)) === JSON.stringify(stripSummary(newRes.summary)));

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
try { unlinkSync(headFile); } catch { /* best-effort cleanup */ }
process.exit(pass === results.length ? 0 : 1);
