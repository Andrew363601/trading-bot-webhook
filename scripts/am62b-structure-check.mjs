// scripts/am62b-structure-check.mjs
// 🟢 PUSH AM62b — units for lib/structure-direction.js (price-structure resolver),
// the fixed candle fetch (lib/candles.js), the loop-health granularity option,
// and the wiring in execute-trade-mcp / the loop-health endpoint / performance.js.
// Run: node scripts/am62b-structure-check.mjs
import { readFileSync } from 'node:fs';
import { deriveStructureDirection, computeStructureBias, EMA_PERIOD, SLOPE_BARS, MIN_BARS } from '../lib/structure-direction.js';
import { deriveLoopHealth, dayKey } from '../lib/loop-health.js';
import { fetchCandles } from '../lib/candles.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

const up = Array.from({ length: 80 }, (_, i) => ({ close: 100 + i * 0.5 }));
const down = Array.from({ length: 80 }, (_, i) => ({ close: 200 - i * 0.5 }));
const flat = Array.from({ length: 80 }, () => ({ close: 100 }));

console.log('\n[1] computeStructureBias — EMA50 + N-bar slope');
{
  ok('constants sane', EMA_PERIOD === 50 && SLOPE_BARS === 10 && MIN_BARS === 51);
  ok('uptrend -> LONG', computeStructureBias(up) === 'LONG');
  ok('downtrend -> SHORT', computeStructureBias(down) === 'SHORT');
  ok('flat -> null (no clean slope)', computeStructureBias(flat) === null);
  ok('insufficient bars -> null', computeStructureBias(up.slice(0, MIN_BARS - 1)) === null);
  ok('accepts plain number[]', computeStructureBias(up.map(c => c.close)) === 'LONG');
  ok('empty -> null', computeStructureBias([]) === null);
}

console.log('\n[2] deriveStructureDirection — structure wins, CVD is a tiebreak only');
{
  ok('uptrend -> LONG', deriveStructureDirection(up, null) === 'LONG');
  ok('downtrend -> SHORT', deriveStructureDirection(down, null) === 'SHORT');
  ok('flat -> NEUTRAL', deriveStructureDirection(flat, null) === 'NEUTRAL');
  ok('insufficient -> NEUTRAL', deriveStructureDirection(up.slice(0, 10), null) === 'NEUTRAL');
  ok('flat + positive CVD -> LONG (tiebreak)', deriveStructureDirection(flat, '120') === 'LONG');
  ok('flat + negative CVD -> SHORT (tiebreak)', deriveStructureDirection(flat, '-50') === 'SHORT');
  ok('flat + zero CVD -> NEUTRAL', deriveStructureDirection(flat, '0') === 'NEUTRAL');
  ok('flat + null CVD -> NEUTRAL', deriveStructureDirection(flat, null) === 'NEUTRAL');
  ok('structure wins over opposing CVD', deriveStructureDirection(up, '-999') === 'LONG');
  ok('never null for a new row', deriveStructureDirection([], null) === 'NEUTRAL');
}

console.log('\n[3] candle fetch — lib/candles.js returns >0 candles (mocked transport)');
{
  const realFetch = global.fetch;
  let seenUrl = '';
  global.fetch = async (url) => {
    seenUrl = String(url);
    const start = Number((seenUrl.match(/start=(\d+)/) || [])[1]);
    const end = Number((seenUrl.match(/end=(\d+)/) || [])[1]);
    const gran = (seenUrl.match(/granularity=([A-Z_]+)/) || [])[1];
    const step = gran === 'ONE_HOUR' ? 3600 : 300;
    const candles = [];
    for (let t = start; t < end; t += step) {
      candles.push({ start: t, open: '100', high: '101', low: '99', close: '100', volume: '5' });
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candles: candles.reverse() }) };
  };
  try {
    const t0 = 1700000000;
    const candles = await fetchCandles({ product: 'BTC-USD', granularitySeconds: 'FIVE_MINUTE', startEpoch: t0, endEpoch: t0 + 300 * 10 });
    console.log(`  ℹ️  fetchCandles returned ${candles.length} candles`);
    ok('returns >0 candles', candles.length > 0);
    ok('ascending by time', candles.every((c, i) => i === 0 || c.time >= candles[i - 1].time));
    ok('uses api.coinbase.com host', /api\.coinbase\.com/.test(seenUrl));
    ok('uses enum granularity (not seconds)', /granularity=FIVE_MINUTE/.test(seenUrl) && !/granularity=300/.test(seenUrl));
  } finally {
    global.fetch = realFetch;
  }
}

console.log('\n[4] loop-health granularity — both widths return buckets');
{
  const trades = [
    { pnl: 10, exit_time: '2026-09-28T10:00:00Z', model_predicted_win_prob: 0.8, structure_direction: 'LONG' },
    { pnl: -5, exit_time: '2026-09-29T10:00:00Z', model_predicted_win_prob: 0.6, structure_direction: 'SHORT' },
    { pnl: 20, exit_time: '2026-10-05T10:00:00Z', model_predicted_win_prob: 0.7, structure_direction: 'LONG' },
  ];
  const wk = deriveLoopHealth(trades, [], { granularity: 'week' });
  const dy = deriveLoopHealth(trades, [], { granularity: 'day' });
  ok('week -> 2 buckets', wk.weeks.length === 2);
  ok('day -> 3 buckets', dy.weeks.length === 3);
  ok('day keys are YYYY-MM-DD', dy.weeks.every(w => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
  ok('dayKey matches bucket key', dayKey('2026-09-28T10:00:00Z') === '2026-09-28');
  ok('default path == week (byte-identical)', JSON.stringify(deriveLoopHealth(trades, [])) === JSON.stringify(wk));
  ok('series present for both', wk.series.realized.length > 0 && dy.series.realized.length > 0);
}

console.log('\n[5] wiring — execute-trade-mcp (fetch fix + macro structure)');
{
  const exec = readFileSync(new URL('../lib/execute-trade-mcp.js', import.meta.url), 'utf8');
  ok('imports structure-direction', /from '\.\/structure-direction\.js'/.test(exec));
  ok('imports lib/candles', /from '\.\/candles\.js'/.test(exec));
  ok('no geo-blocked host', !/api\.exchange\.coinbase\.com/.test(exec));
  ok('no legacy granularity=300', !/granularity=300/.test(exec));
  ok('chart fetch via lib/candles (5m)', /fetchCandles\(\{ product: coinbaseProduct, granularitySeconds: 'FIVE_MINUTE'/.test(exec));
  ok('macro TTL cache present', /macroCandleCache/.test(exec));
  ok('entry derives from macro candles', /deriveStructureDirection\(\s*entryMacroCandles/.test(exec));
  ok('close derives from macro candles', /structure_direction: deriveStructureDirection\(\s*await fetchStructureCandles/.test(exec));
  ok('params_context mirror kept', /entryParamsContext\.structure_direction = structureDirection/.test(exec));
  ok('retry guard kept', /delete without\.structure_direction/.test(exec));
}

console.log('\n[6] wiring — endpoint + panel granularity');
{
  const ep = readFileSync(new URL('../pages/api/performance/loop-health.js', import.meta.url), 'utf8');
  ok('endpoint reads ?granularity', /req\.query\.granularity === 'day'/.test(ep));
  ok('endpoint passes granularity', /deriveLoopHealth\(trades, lessons, \{ granularity \}\)/.test(ep));
  ok('endpoint echoes granularity', /granularity,\s*\n\s*window: windowMeta/.test(ep));

  const perf = readFileSync(new URL('../pages/performance.js', import.meta.url), 'utf8');
  ok('loop granularity state', /const \[loopGranularity, setLoopGranularity\]/.test(perf));
  ok('loop fetch uses granularity', /granularity: loopGranularity\.toLowerCase\(\)/.test(perf));
  ok('loop fetch effect depends on it', /\}, \[session\?\.access_token, loopGranularity\]\)/.test(perf));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
