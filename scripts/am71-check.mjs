// scripts/am71-check.mjs
// 🟢 AM71 GATE — backtest venue allowlist + session-only display + stale PENDING
// resolution + trading-box context.
//
//   F  backtest-service.js: venue ALLOWLIST (coinbase/krakenspot/krakenfutures
//      pass; kraken → KRX marks-only refusal; unknown → loud refusal). BEHAVIORAL
//      vectors drive runBacktestForTenant with a mock supabase.
//   F2 asset-contract-size.js: SPOT guard — any `-SPOT-` id → 1.0; Coinbase perp
//      ids unchanged (BEHAVIORAL vectors).
//   E  pages/studio.js: NO persisted-result render + NO AM50 auto-sync; AM47c
//      prefill + product default still present.
//   D  workers/shadow-portfolio.js: stale-PENDING guard at BOTH unresolved exit
//      points (STALE_DATA/NEUTRAL, sim_exit_time = veto_time + 24h).
//   C  lib/trading-box.js: pure box math (range/position/width/VWAP/too-narrow),
//      book-failure degradation, missing-input absence; stamp present at all four
//      insert sites.
//
// Read-only; never mutates the repo. Run: node scripts/am71-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(path.join(ROOT, rel));
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A chainable, awaitable supabase mock: any method returns the proxy; awaiting it
// resolves { data: null, error: null }. Enough to drive runBacktestForTenant past
// the venue guard into the strategy lookup (which then throws NOT_FOUND).
function makeMockSupabase() {
  const handler = {
    get(_t, prop) {
      if (prop === 'then') return (resolve) => resolve({ data: null, error: null });
      return () => proxy;
    },
  };
  const proxy = new Proxy(function () {}, handler);
  return proxy;
}

console.log('AM71 backtest allowlist + session-only display + stale PENDING + trading-box check\n');

// ═══════════════════ F. backtest-service venue allowlist ═══════════════════
console.log('── F. lib/backtest-service.js — venue allowlist ──');
const BT = 'lib/backtest-service.js';
check('backtest-service.js exists', exists(BT));
if (exists(BT)) {
  const src = read(BT);
  check('allowlist constant present (coinbase/krakenspot/krakenfutures)',
    /BACKTEST_VENUES\s*=\s*\[\s*'coinbase'\s*,\s*'krakenspot'\s*,\s*'krakenfutures'\s*\]/.test(src));
  check('kraken refusal carries the KRX marks-only message',
    /\[AM71\] backtests refuse exchange 'kraken' — KRX is marks-only \(no intraday OHLC\) and would silently fabricate Coinbase-shaped data\. Refusing\./.test(src));
  check('unknown-venue refusal is loud + AM71-tagged',
    /\[AM71\] backtests refuse exchange '\$\{exchange\}'/.test(src));
  check('stale "until Push 4" wording is GONE', !/until Push 4/.test(src));
  check('fee note present (agent_taker_fee_rate)', /agent_taker_fee_rate/.test(src));
  check('venue echo uses the validated venue (not hardcoded coinbase)',
    /exchange:\s*btExchange/.test(src) && !/exchange:\s*'coinbase',\s*\n\s*first_close/.test(src));

  // ── BEHAVIORAL: drive the guard with a mock supabase. ──
  let mod = null;
  try { mod = await import(pathToFileURL(path.join(ROOT, BT)).href); }
  catch (e) { check('backtest-service imports cleanly', false, e.message); }

  if (mod?.runBacktestForTenant) {
    const mock = makeMockSupabase();
    const base = { product: 'BTC-USD', strategy_id: 'x', start: 1700000000, end: 1700100000 };

    // Refused: kraken → exact KRX message.
    let krakenMsg = '';
    try { await mod.runBacktestForTenant(mock, 't-kraken', { ...base, exchange: 'kraken' }); }
    catch (e) { krakenMsg = e.message; }
    check('BEHAVIORAL: kraken refused with the KRX marks-only message',
      /\[AM71\] backtests refuse exchange 'kraken'/.test(krakenMsg) && /marks-only/.test(krakenMsg), krakenMsg);

    // Refused: unknown venue → loud refusal.
    let unknownMsg = '';
    try { await mod.runBacktestForTenant(mock, 't-unknown', { ...base, exchange: 'bybit' }); }
    catch (e) { unknownMsg = e.message; }
    check('BEHAVIORAL: unknown venue refused LOUD',
      /\[AM71\] backtests refuse exchange 'bybit'/.test(unknownMsg), unknownMsg);

    // Allowed: krakenspot / krakenfutures / coinbase pass the guard (they then
    // fail later at the strategy lookup — NOT_FOUND — proving the guard let them by).
    for (const venue of ['krakenspot', 'krakenfutures', 'coinbase']) {
      let msg = '', code = '';
      try { await mod.runBacktestForTenant(mock, `t-${venue}`, { ...base, exchange: venue }); }
      catch (e) { msg = e.message; code = e.code; }
      const passedGuard = !/\[AM71\] backtests refuse/.test(msg);
      check(`BEHAVIORAL: ${venue} passes the venue guard`, passedGuard, msg || code);
    }
  }
}

// ═══════════════════ F2. asset-contract-size SPOT guard ═══════════════════
console.log('\n── F2. lib/asset-contract-size.js — SPOT guard ──');
const ACS = 'lib/asset-contract-size.js';
check('asset-contract-size.js exists', exists(ACS));
if (exists(ACS)) {
  const src = read(ACS);
  check('SPOT guard present (includes -SPOT- → 1.0)', /includes\('-SPOT-'\)\s*\)\s*return 1\.0/.test(src));
  let m = null;
  try { m = await import(pathToFileURL(path.join(ROOT, ACS)).href); }
  catch (e) { check('asset-contract-size imports cleanly', false, e.message); }
  if (m?.contractSizeFor) {
    const spot = ['BTC-SPOT-KRS', 'ETH-SPOT-KRS', 'SOL-SPOT-KRS', 'DOGE-SPOT-KRS'];
    const spotOk = spot.every((s) => m.contractSizeFor(s) === 1.0);
    check('BEHAVIORAL: all -SPOT-KRS ids → 1.0', spotOk,
      spot.map((s) => `${s}=${m.contractSizeFor(s)}`).join(' '));
    const perps = [['SOL-PERP-INTX', 5.0], ['BTC-PERP-INTX', 0.01], ['DOGE-PERP-INTX', 1000.0]];
    const perpOk = perps.every(([s, v]) => m.contractSizeFor(s) === v);
    check('BEHAVIORAL: Coinbase perp ids unchanged', perpOk,
      perps.map(([s]) => `${s}=${m.contractSizeFor(s)}`).join(' '));
  }
}

// ═══════════════════ E. studio session-only display ═══════════════════
console.log('\n── E. pages/studio.js — session-only backtest display ──');
const STU = 'pages/studio.js';
check('studio.js exists', exists(STU));
if (exists(STU)) {
  const raw = read(STU);
  const src = stripComments(raw);
  check('ABSENCE: no persisted-result render (setBacktestResult(data.strategy.latest_backtest))',
    !/setBacktestResult\(\s*data\.strategy\.latest_backtest\s*\)/.test(src));
  check('ABSENCE: no AM50 auto-sync effect (autoSyncedRef gone)', !/autoSyncedRef/.test(src));
  check('ABSENCE: no auto-sync fetch of latest_backtest for render',
    !/Backtest auto-sync/.test(raw));
  check('PRESENCE: AM47c parameter prefill still there',
    /cfgParams\.target_usd/.test(src) && /setSimTargetUsd/.test(src));
  check('PRESENCE: product default from latest_backtest.product still there',
    /lbProduct\s*=\s*selectedStrategy\?\.latest_backtest\?\.product/.test(src));
  check('PRESENCE: post-run stamp kept (backtestExecutedAtRef)',
    /backtestExecutedAtRef\.current\s*=\s*data\.executed_at/.test(src));
}

// ═══════════════════ D. stale PENDING resolution ═══════════════════
console.log('\n── D. workers/shadow-portfolio.js — stale PENDING resolution ──');
const SP = 'workers/shadow-portfolio.js';
check('shadow-portfolio.js exists', exists(SP));
if (exists(SP)) {
  const src = read(SP);
  check('STALE_GRACE_MS constant present (6h)', /STALE_GRACE_MS\s*=\s*6\s*\*\s*3600\s*\*\s*1000/.test(src));
  check('SHADOW_HORIZON_MS constant present (24h)', /SHADOW_HORIZON_MS\s*=\s*24\s*\*\s*3600\s*\*\s*1000/.test(src));
  check('isStalePending helper present', /function isStalePending\s*\(/.test(src));
  const staleCount = (src.match(/simExitReason = 'STALE_DATA'/g) || []).length;
  check('STALE_DATA set at BOTH unresolved exit points (no-sim + no-candles)', staleCount >= 2, `found ${staleCount}`);
  const neutralCount = (src.match(/verdict = 'NEUTRAL';/g) || []).length;
  check('NEUTRAL verdict set on the stale path', neutralCount >= 2, `found ${neutralCount}`);
  check('sim_exit_time = veto_time + horizon on the stale path',
    /simExitTime = new Date\(new Date\(vetoTime\)\.getTime\(\) \+ SHADOW_HORIZON_MS\)\.toISOString\(\)/.test(src));
  check('stale guard is gated on pendingRow + isStalePending',
    /pendingRow && isStalePending\(vetoTime\)/.test(src));
  check('AM2h poison guard intact (sim did not resolve → stays PENDING)',
    /sim did not resolve — ticket stays PENDING/.test(src));
  check('Discord notify stays SAVED/MISSED-only (no STALE spam)',
    /row\.verdict !== 'SAVED' && row\.verdict !== 'MISSED'/.test(src));
}

// ═══════════════════ C. trading-box context ═══════════════════
console.log('\n── C. lib/trading-box.js + stamp ──');
const TB = 'lib/trading-box.js';
check('lib/trading-box.js exists', exists(TB));
if (exists(TB)) {
  let m = null;
  try { m = await import(pathToFileURL(path.join(ROOT, TB)).href); }
  catch (e) { check('trading-box imports cleanly', false, e.message); }
  if (m?.buildTradingBox) {
    // Box math vector: range 100–200, price 150 → 50% from bottom; ATR 25 → width 4×.
    const candles = [
      { time: 1, open: 100, high: 120, low: 100, close: 110, volume: 10 },
      { time: 2, open: 110, high: 200, low: 110, close: 190, volume: 10 },
      { time: 3, open: 190, high: 190, low: 140, close: 150, volume: 10 },
      { time: 4, open: 150, high: 160, low: 130, close: 150, volume: 10 },
      { time: 5, open: 150, high: 155, low: 145, close: 150, volume: 10 },
    ];
    const box = await m.buildTradingBox({ venue: 'coinbase', product: 'X', macroCandles: candles, macroAtr: 25, fetchBook: null });
    check('BEHAVIORAL: box available with valid inputs', box.available === true, box.reason || '');
    check('BEHAVIORAL: range_top = 200', box.range_top === 200, String(box.range_top));
    check('BEHAVIORAL: range_bottom = 100', box.range_bottom === 100, String(box.range_bottom));
    check('BEHAVIORAL: position_pct = 50', Math.abs(box.position_pct - 50) < 1e-9, String(box.position_pct));
    check('BEHAVIORAL: width_atr = 4', Math.abs(box.width_atr - 4) < 1e-9, String(box.width_atr));
    check('BEHAVIORAL: too_narrow_hint false (width 4 ≥ 1)', box.too_narrow_hint === false);
    check('BEHAVIORAL: VWAP computed (finite)', Number.isFinite(box.vwap), String(box.vwap));
    check('BEHAVIORAL: summary is self-describing', /Trading box/.test(box.summary || ''), box.summary || '');

    // too-narrow vector: width < 1× ATR.
    const narrow = await m.buildTradingBox({ venue: 'coinbase', product: 'X', macroCandles: candles, macroAtr: 500, fetchBook: null });
    check('BEHAVIORAL: too_narrow_hint true when width < 1× ATR', narrow.too_narrow_hint === true, String(narrow.width_atr));

    // Book-failure degradation: fetchBook throws → box still available, walls null.
    const degraded = await m.buildTradingBox({
      venue: 'coinbase', product: 'X', macroCandles: candles, macroAtr: 25,
      fetchBook: async () => { throw new Error('book down'); },
    });
    check('BEHAVIORAL: book failure degrades walls only (available stays true)',
      degraded.available === true && degraded.walls.defending === null && degraded.walls.opposing === null);
    check('BEHAVIORAL: book failure is named in the summary', /book unavailable/.test(degraded.summary || ''), degraded.summary || '');

    // Missing-input absence vectors.
    const noCandles = await m.buildTradingBox({ venue: 'coinbase', product: 'X', macroCandles: [], macroAtr: 25, fetchBook: null });
    check('BEHAVIORAL: too-short candles → available:false', noCandles.available === false && /too short/.test(noCandles.reason || ''), noCandles.reason || '');
    const noAtr = await m.buildTradingBox({ venue: 'coinbase', product: 'X', macroCandles: candles, macroAtr: null, fetchBook: null });
    check('BEHAVIORAL: null ATR → available:false', noAtr.available === false && /ATR/.test(noAtr.reason || ''), noAtr.reason || '');
  }
}

// Stamp presence at all four insert sites + the KRX unavailable branch.
const EXEC = 'lib/execute-trade-mcp.js';
check('execute-trade-mcp.js exists', exists(EXEC));
if (exists(EXEC)) {
  const src = read(EXEC);
  check('trading_box stamped into entryParamsContext', /entryParamsContext\.trading_box\s*=/.test(src));
  check('KRX branch stamps the marks-only unavailable box',
    /trading_box = \{ available: false, reason: 'marks-only venue — no intraday OHLC' \}/.test(src));
  check('buildTradingBox imported', /import \{ buildTradingBox \} from '\.\/trading-box\.js'/.test(src));
  check('KRF book door = getKrakenOrderBook (real export)', /getKrakenOrderBook\(\{ nativeSymbol: krakenFuturesProduct\.nativeSymbol \}\)/.test(src));
  check('KSPOT book door = getKrakenSpotOrderBook', /getKrakenSpotOrderBook\(krakenSpotProduct\.nativeSymbol/.test(src));
  check('Coinbase book door = product_book', /product_book\?product_id=\$\{coinbaseProduct\}&limit=50/.test(src));
  const insertSites = (src.match(/params_context:\s*entryParamsContext/g) || []).length;
  check('all four insert sites carry params_context: entryParamsContext', insertSites >= 4, `found ${insertSites}`);
}

// ═══════════════════ summary ═══════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} AM71 check: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
process.exit(0);
