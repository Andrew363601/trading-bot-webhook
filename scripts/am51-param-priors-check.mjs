// AM51 — strategy_param_priors bank validation (mocked Supabase, no DB).
//
// Proves:
//  1. A backtest run upserts one priors row per NON-ZERO regime bucket.
//  2. n matches regime_breakdown; expectancy = pnl_usd / n.
//  3. Zero-n buckets are skipped (no div-by-zero / null win_rate rows).
//  4. regime_proxy_version is carried (not 'classifier_version').
//  5. A priors upsert failure never fails the run.
//
// Run: node scripts/am51-param-priors-check.mjs
import { runBacktestForTenant } from '../lib/backtest-service.js';

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

const captured = { priors: null, studio_runs: null, backtest_results: null, priorsError: null };

function makeQuery(table) {
  const q = {
    select: () => q,
    eq: () => q,
    or: () => q,
    order: () => q,
    limit: () => q,
    gte: () => q,
    update: () => q,
    insert: (payload) => {
      if (table === 'studio_runs') captured.studio_runs = payload;
      if (table === 'backtest_results') captured.backtest_results = payload;
      return q;
    },
    upsert: (payload) => {
      if (table === 'strategy_param_priors') {
        captured.priors = payload;
        return Promise.resolve({ data: null, error: captured.priorsError });
      }
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle: async () => {
      if (table === 'backtest_results') return { data: { id: '11111111-1111-1111-1111-111111111111' }, error: null };
      if (table === 'strategy_library') return { data: { id: '33333333-3333-3333-3333-333333333333', name: 'sma_cross', version: 1, code, tenant_id: '22222222-2222-2222-2222-222222222222' }, error: null };
      return { data: null, error: null };
    }
  };
  return q;
}
const supabase = { from: (table) => makeQuery(table) };

const end = Math.floor(Date.now() / 1000) - 2 * 86400;
const start = end - 2 * 86400;

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

let runResult = null;
try {
  runResult = await runBacktestForTenant(supabase, '22222222-2222-2222-2222-222222222222', {
    strategy_name: 'sma_cross',
    code,
    parameters: { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005, veto_cooldown_minutes: 5 },
    product: 'BTC-USD',
    macro_tf: 'ONE_HOUR',
    trigger_tf: 'FIVE_MINUTE',
    start,
    end
  });
} catch (err) {
  console.error('runBacktestForTenant threw:', err.message);
  process.exit(1);
}

const rows = captured.priors;
check('priors upsert called', Array.isArray(rows) && rows.length > 0, `rows=${rows ? rows.length : 0}`);

if (Array.isArray(rows)) {
  const rb = runResult.summary.regime_breakdown || {};
  const nonZero = Object.entries(rb).filter(([, b]) => b.n > 0).map(([r]) => r);
  check('one row per non-zero regime', rows.length === nonZero.length, `${rows.length} vs ${nonZero.length}`);
  check('no zero-n rows', rows.every((r) => r.n > 0));
  check('n matches regime_breakdown', rows.every((r) => r.n === rb[r.regime].n));
  check('expectancy = pnl_usd / n', rows.every((r) => Math.abs(r.metrics.expectancy - (rb[r.regime].pnl_usd / r.n)) < 1e-3));
  check('wr matches breakdown', rows.every((r) => r.metrics.wr === rb[r.regime].win_rate));
  check('regime_proxy_version carried', rows.every((r) => r.regime_proxy_version === runResult.summary.regime_proxy_version), rows[0]?.regime_proxy_version);
  check('no classifier_version key', rows.every((r) => !('classifier_version' in r)));
  check('library_id set', rows.every((r) => r.library_id === '33333333-3333-3333-3333-333333333333'));
  check('source=backtest', rows.every((r) => r.source === 'backtest'));
}

// 5. Upsert failure must not fail the run.
captured.priors = null;
captured.priorsError = { message: 'simulated priors failure' };
let survived = true;
try {
  await runBacktestForTenant(supabase, '22222222-2222-2222-2222-222222222222', {
    strategy_name: 'sma_cross', code,
    parameters: { qty: 1, leverage: 2, tp_percent: 0.01, sl_percent: 0.005, veto_cooldown_minutes: 5 },
    product: 'BTC-USD', macro_tf: 'ONE_HOUR', trigger_tf: 'FIVE_MINUTE', start, end
  });
} catch { survived = false; }
check('priors failure never fails the run', survived);

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
