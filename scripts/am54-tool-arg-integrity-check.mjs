// scripts/am54-tool-arg-integrity-check.mjs
// 🟢 PUSH AM54 — tool-arg integrity checks.
//   Unit A: runBacktestForTenant with `parameters` as a JSON STRING parses and
//           produces DIFFERENT results than defaults (never a silent default
//           replication); an invalid string fails LOUD.
//   Unit B: resolveStrategyIdentifier with only { strategy_name } resolves.
//   Unit C: resolveStrategyIdentifier with neither -> loud "name is required".
// Run: node scripts/am54-tool-arg-integrity-check.mjs

import { normalizeParametersArg, resolveStrategyIdentifier } from '../lib/tool-arg-integrity.js';
import { runBacktestForTenant } from '../lib/backtest-service.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  [' + extra + ']' : ''}`); } else { fail++; console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`); } }

// ── synthetic candle source (stub global.fetch) ──
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
function pricePath(n, base = 100) {
  const rnd = rng(7); const out = []; let p = base;
  for (let i = 0; i < n; i++) {
    const drift = i < n * 0.5 ? 0.05 : -0.03;
    p += drift + rnd() * 1.2;
    const r = 0.4 + Math.abs(rnd());
    out.push({ open: p, high: p + r / 2, low: p - r / 2, close: p, volume: 10 });
  }
  return out;
}
const N = 3000;
const t0 = 1700000000;
const path = pricePath(N);
const trigger5m = path.map((c, i) => ({ ...c, time: t0 + i * 300 }));
const macro1h = [];
for (let i = 0; i < N; i += 12) {
  const w = path.slice(i, i + 12);
  macro1h.push({ open: w[0].open, high: Math.max(...w.map(x => x.high)), low: Math.min(...w.map(x => x.low)), close: w[w.length - 1].close, volume: 120, time: t0 + i * 300 });
}

const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  const gran = (u.match(/granularity=([A-Z_]+)/) || [])[1] || 'FIVE_MINUTE';
  const src = gran === 'ONE_HOUR' ? macro1h : trigger5m;
  // Coinbase raw shape: { start, open, high, low, close, volume } descending.
  const candles = src.map(c => ({ start: c.time, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: String(c.volume) })).reverse();
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candles }), text: async () => '' };
};

// ── minimal supabase stub ──
function makeSupabase(strategyRow) {
  const chain = {
    _op: null,
    select() { return this; },
    eq() { return this; },
    or() { return this; },
    order() { return this; },
    limit() { return this; },
    update() { this._op = 'update'; return this; },
    insert() { this._op = 'insert'; return this; },
    async maybeSingle() { return { data: this._op === 'insert' ? { id: 'run-1' } : strategyRow, error: null }; },
    then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve); }
  };
  return { from() { return Object.create(chain); } };
}

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

const strategyRow = { id: 'lib-1', name: 'am54_test', version: 1, code, visibility: 'private', tenant_id: 'tenant-1' };
const supabase = makeSupabase(strategyRow);

const baseArgs = {
  strategy_name: 'am54_test',
  product: 'BTC-USD',
  macro_tf: 'ONE_HOUR',
  trigger_tf: 'FIVE_MINUTE',
  start: t0,
  end: t0 + N * 300
};

// ── Unit A ──
console.log('Unit A — runBacktestForTenant parameters normalization');
let defaultsRes, stringRes, objectRes, invalidErr = null;
try {
  defaultsRes = await runBacktestForTenant(supabase, 'tenant-A', { ...baseArgs, parameters: {} });
  stringRes = await runBacktestForTenant(supabase, 'tenant-B', { ...baseArgs, parameters: '{"tp_percent":0.01,"sl_percent":0.005,"leverage":3}' });
  objectRes = await runBacktestForTenant(supabase, 'tenant-C', { ...baseArgs, parameters: { tp_percent: 0.01, sl_percent: 0.005, leverage: 3 } });
} catch (e) { console.log('  (unexpected throw)', e.message); }
try {
  await runBacktestForTenant(supabase, 'tenant-D', { ...baseArgs, parameters: '{not valid json' });
} catch (e) { invalidErr = e; }

ok('defaults run produced a summary', !!defaultsRes?.summary);
ok('string-parameters run produced a summary', !!stringRes?.summary);
ok('string-parameters run is NOT a silent default replication',
  JSON.stringify(stringRes?.summary) !== JSON.stringify(defaultsRes?.summary),
  `defaults pnl=${defaultsRes?.summary?.total_pnl_usd} vs string pnl=${stringRes?.summary?.total_pnl_usd}`);
ok('string-parameters run equals the equivalent OBJECT run (parse worked)',
  JSON.stringify(stringRes?.summary) === JSON.stringify(objectRes?.summary));
ok('invalid JSON string fails LOUD (BAD_REQUEST)', invalidErr?.code === 'BAD_REQUEST', invalidErr?.message);
ok('invalid JSON string never silently replicates defaults', invalidErr != null);

// ── Unit B ──
console.log('Unit B — resolveStrategyIdentifier alias');
const b = resolveStrategyIdentifier({ strategy_name: 'ut_bot_replica_v1' });
ok('strategy_name alias resolves', b.ok === true && b.name === 'ut_bot_replica_v1');
const b2 = resolveStrategyIdentifier({ name: 'x_v1' });
ok('name still resolves', b2.ok === true && b2.name === 'x_v1');

// ── Unit C ──
console.log('Unit C — empty identifier is a PARAM error');
const c = resolveStrategyIdentifier({});
ok('empty identifier -> not ok', c.ok === false);
ok('empty identifier -> loud "name is required"', /name is required/.test(c.error || ''), c.error);
ok('empty identifier -> never "Strategy \'\' not found"', !/not found/.test(c.error || ''));

// ── normalizeParametersArg direct ──
console.log('normalizeParametersArg direct');
ok('undefined -> {}', normalizeParametersArg(undefined).parameters && Object.keys(normalizeParametersArg(undefined).parameters).length === 0);
ok('string -> parsed + flag', normalizeParametersArg('{"a":1}').parameters.a === 1 && normalizeParametersArg('{"a":1}').normalizedFromString === true);
ok('array -> loud error', normalizeParametersArg([1, 2]).ok === false);
ok('number -> loud error', normalizeParametersArg(5).ok === false);

global.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
