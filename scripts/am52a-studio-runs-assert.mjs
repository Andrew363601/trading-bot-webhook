// AM52a assert: drive runBacktestForTenant end-to-end with REAL Coinbase candles
// (public API, no credentials) and a MOCKED Supabase client (no .env in this
// clone), then assert the studio_runs insert row is complete and correct.
//
// Run: node scripts/am52a-studio-runs-assert.mjs
import { runBacktestForTenant } from '../lib/backtest-service.js';

// ---- Mock Supabase: capture inserts, satisfy the chains the service uses ----
const captured = { studio_runs: null, backtest_results: null };

function makeQuery(table) {
  const q = {
    select: () => q,
    eq: () => q,
    or: () => q,
    order: () => q,
    limit: () => q,
    update: () => q,
    insert: (payload) => {
      if (table === 'studio_runs') captured.studio_runs = payload;
      if (table === 'backtest_results') captured.backtest_results = payload;
      return q;
    },
    maybeSingle: async () => {
      if (table === 'backtest_results') return { data: { id: '11111111-1111-1111-1111-111111111111' }, error: null };
      return { data: null, error: null };
    }
  };
  return q;
}

const supabase = { from: (table) => makeQuery(table) };

// ---- Trivial strategy (SMA cross), same shape as the AM50 smoke ----
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

// Recent 2-day window (keeps candle count small; Coinbase public data).
const end = Math.floor(Date.now() / 1000) - 2 * 86400;
const start = end - 2 * 86400;

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

let runResult = null;
try {
  runResult = await runBacktestForTenant(supabase, '22222222-2222-2222-2222-222222222222', {
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

const row = captured.studio_runs;
check('studio_runs row inserted', !!row);
check('backtest_results row inserted', !!captured.backtest_results);

if (row) {
  const trades = Array.isArray(row.trades) ? row.trades : [];
  const rb = row.regime_breakdown || {};
  const buckets = ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'];

  check('product echoed', row.product === 'BTC-USD', row.product);
  check('horizon = 5M', row.horizon === '5M', row.horizon);
  check('first_close is a number', typeof row.first_close === 'number' && row.first_close > 0, String(row.first_close));
  check('run_window has start/end/days', row.run_window && row.run_window.start && row.run_window.end && typeof row.run_window.days === 'number', JSON.stringify(row.run_window));
  check('run_id linked', row.run_id === '11111111-1111-1111-1111-111111111111', String(row.run_id));
  check('trades non-empty', trades.length > 0, `n=${trades.length}`);
  check('every trade has a regime', trades.length > 0 && trades.every(t => buckets.includes(t.regime)), JSON.stringify([...new Set(trades.map(t => t.regime))]));
  check('regime_breakdown has 4 buckets', buckets.every(b => rb[b] && typeof rb[b].n === 'number'), JSON.stringify(Object.keys(rb)));
  check('regime_proxy_version = proxy_v1', row.regime_proxy_version === 'proxy_v1', String(row.regime_proxy_version));
  check('summary.total_trades matches trades.length', row.summary && row.summary.total_trades === trades.length, `summary=${row.summary?.total_trades} trades=${trades.length}`);
  check('summary has pnl_percent', row.summary && typeof row.summary.pnl_percent === 'number', String(row.summary?.pnl_percent));
  check('equity_curve present', Array.isArray(row.equity_curve) && row.equity_curve.length > 0, `n=${row.equity_curve?.length}`);
  check('trigger_candles present', Array.isArray(row.trigger_candles) && row.trigger_candles.length > 0, `n=${row.trigger_candles?.length}`);
  check('regime_breakdown n sums to total_trades', buckets.reduce((s, b) => s + (rb[b]?.n || 0), 0) === trades.length, `sum=${buckets.reduce((s, b) => s + (rb[b]?.n || 0), 0)}`);
}

console.log('\n=== AM52a studio_runs persistence assert ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
