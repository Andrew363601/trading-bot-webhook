// AM53b2 — calibrate the regime proxy against canon labels (READ-ONLY).
//
// Goal: the OHLCV proxy is TREND-blind vs the live canon classifier. This
// script replays the proxy over the macro slice at each canon-labeled trade's
// timestamp, builds a canon x proxy agreement matrix, then grid-searches the
// four tunable thresholds for the best overall agreement.
//
// NO DB WRITES. NO file writes. Prints BEFORE/AFTER matrices + top-5 combos.
//
// Modes:
//   LIVE      — requires SUPABASE_SERVICE_ROLE_KEY (pulls trade_logs + candles).
//   SYNTHETIC — no key present: validates the grid-search machinery on a
//               generated fixture so the script is runnable in CI/clone.
//
// Run: node scripts/am53b2-calibrate.mjs
import { createClient } from '@supabase/supabase-js';
import {
  REGIME_PROXY_CONSTANTS,
  REGIME_PROXY_VERSION,
  regimeProxyFeatures,
  classifyRegimeFromFeatures,
} from '../lib/regime-proxy.js';

const REGIMES = ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'];
const VALID = new Set(REGIMES);
const LOOKBACK_DAYS = 90;

// Canon labels are historically polluted with status strings ("EVALUATING",
// "AGENT VETO", ...). Only exact canon labels count as ground truth.
const normalizeRegime = (r) => (VALID.has(r) ? r : null);

// ── Grid definition (matches the push spec) ──
const range = (lo, hi, step) => {
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(parseFloat(v.toFixed(4)));
  return out;
};
const GRID = {
  DISPLACEMENT_TREND: range(0.6, 2.0, 0.1),
  RANGE_COMPRESSION: range(0.3, 1.2, 0.1),
  POS_ACCUM_MAX: range(0.2, 0.45, 0.05),
  POS_DIST_MIN: range(0.55, 0.8, 0.05),
};

// ── Agreement matrix helpers ──
function emptyMatrix() {
  const m = {};
  for (const c of REGIMES) { m[c] = {}; for (const p of REGIMES) m[c][p] = 0; }
  return m;
}
function matrixStats(matrix, total) {
  let agree = 0;
  const perRegime = {};
  for (const c of REGIMES) {
    const rowTotal = REGIMES.reduce((a, p) => a + matrix[c][p], 0);
    const hit = matrix[c][c];
    agree += hit;
    perRegime[c] = { n: rowTotal, hit, rate: rowTotal > 0 ? hit / rowTotal : null };
  }
  return { agree, overall: total > 0 ? agree / total : 0, perRegime };
}
function printMatrix(label, matrix, stats) {
  console.log(`\n${label}`);
  console.log('canon \\ proxy'.padEnd(16) + REGIMES.map((r) => r.slice(0, 6).padStart(8)).join('') + '   hit-rate');
  for (const c of REGIMES) {
    const row = REGIMES.map((p) => String(matrix[c][p]).padStart(8)).join('');
    const pr = stats.perRegime[c];
    const rate = pr.rate == null ? '  —' : `${(pr.rate * 100).toFixed(1)}%`;
    console.log(c.padEnd(16) + row + `   ${rate} (n=${pr.n})`);
  }
  console.log(`overall agreement: ${(stats.overall * 100).toFixed(2)}%  (${stats.agree}/${stats.agree === 0 ? 0 : ''}${Object.values(stats.perRegime).reduce((a, r) => a + r.n, 0)})`);
}

// ── Data acquisition ──
async function loadLiveRows() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const supabase = createClient(url, key);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const { data, error } = await supabase
    .from('trade_logs')
    .select('tenant_id, symbol, macro_tf, regime_at_entry, created_at')
    .not('regime_at_entry', 'is', null)
    .gte('created_at', since)
    .limit(5000);
  if (error) { console.error('[AM53b2] trade_logs fetch failed:', error.message); return null; }
  return (data || []).filter((r) => normalizeRegime(r.regime_at_entry) && r.symbol && r.macro_tf);
}

// Synthetic fixture: a mixed-regime path with known canon labels, so the
// grid-search machinery is exercised without DB access.
function syntheticRows() {
  const rows = [];
  const t0 = 1700000000;
  const rnd = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; };
  const r = rnd(99);
  let p = 100;
  for (let i = 0; i < 1200; i++) {
    let drift = 0, amp = 1, label = 'CHOP';
    if (i < 400) { drift = 0.08; amp = 0.7; label = 'TREND'; }
    else if (i < 800) { drift = 0; amp = 0.5; label = 'CHOP'; }
    else { drift = 0; amp = 0.08; label = i % 2 === 0 ? 'ACCUMULATION' : 'DISTRIBUTION'; }
    p += drift + r() * amp;
    rows.push({ tenant_id: 'synthetic', symbol: 'BTC-USD', macro_tf: 'ONE_HOUR', regime_at_entry: label, created_at: new Date((t0 + i * 3600) * 1000).toISOString() });
  }
  return rows;
}

// Build a macro candle series covering the row range (synthetic only).
function syntheticCandles(rows) {
  const rnd = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; };
  const r = rnd(99);
  let p = 100;
  const out = [];
  for (let i = 0; i < 1200; i++) {
    let drift = 0, amp = 1;
    if (i < 400) { drift = 0.08; amp = 0.7; }
    else if (i < 800) { drift = 0; amp = 0.5; }
    else { drift = 0; amp = 0.08; }
    p += drift + r() * amp;
    const rr = amp * (0.4 + Math.abs(r()));
    out.push({ time: 1700000000 + i * 3600, open: p, high: p + rr / 2, low: p - rr / 2, close: p, volume: 1 });
  }
  return out;
}

// ── Main ──
const liveRows = await loadLiveRows();
const mode = liveRows ? 'LIVE' : 'SYNTHETIC';
const rows = liveRows || syntheticRows();
console.log(`[AM53b2] mode=${mode}  rows=${rows.length}  current version=${REGIME_PROXY_VERSION}`);

if (!rows.length) { console.error('[AM53b2] no canon rows — nothing to calibrate.'); process.exit(1); }

// Group rows by (symbol, macro_tf) and fetch one candle series per group.
const groups = new Map();
for (const row of rows) {
  const k = `${row.symbol}|${row.macro_tf}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(row);
}

let fetchCandles = null;
if (mode === 'LIVE') {
  ({ fetchCandles } = await import('../lib/candles.js'));
}

// Precompute features per trade (features are threshold-independent).
const samples = []; // { canon, features }
for (const [k, groupRows] of groups) {
  const [symbol, macroTf] = k.split('|');
  let candles;
  if (mode === 'LIVE') {
    const times = groupRows.map((r) => Math.floor(new Date(r.created_at).getTime() / 1000));
    const startEpoch = Math.min(...times) - 400 * 3600;
    const endEpoch = Math.max(...times) + 3600;
    try {
      candles = await fetchCandles({ product: symbol, granularitySeconds: macroTf, startEpoch, endEpoch });
    } catch (e) {
      console.warn(`[AM53b2] candle fetch failed for ${k}: ${e.message}`);
      continue;
    }
  } else {
    candles = syntheticCandles(groupRows);
  }
  if (!candles || !candles.length) continue;

  for (const row of groupRows) {
    const canon = normalizeRegime(row.regime_at_entry);
    if (!canon) continue;
    const t = Math.floor(new Date(row.created_at).getTime() / 1000);
    const slice = candles.filter((c) => c.time <= t);
    const features = regimeProxyFeatures(slice, REGIME_PROXY_CONSTANTS);
    samples.push({ canon, features });
  }
}

console.log(`[AM53b2] usable samples=${samples.length}`);
if (!samples.length) { console.error('[AM53b2] no usable samples.'); process.exit(1); }

// BEFORE matrix (current constants).
function matrixFor(constants) {
  const m = emptyMatrix();
  for (const s of samples) {
    const proxy = classifyRegimeFromFeatures(s.features, constants);
    m[s.canon][proxy] += 1;
  }
  return m;
}
const beforeMatrix = matrixFor(REGIME_PROXY_CONSTANTS);
const beforeStats = matrixStats(beforeMatrix, samples.length);
printMatrix('BEFORE (proxy_v1 constants)', beforeMatrix, beforeStats);

// Grid search. Objective: overall agreement; tie-break = balanced per-regime
// hits (min per-regime hit-rate, then mean).
let best = null;
const scored = [];
for (const DISPLACEMENT_TREND of GRID.DISPLACEMENT_TREND)
  for (const RANGE_COMPRESSION of GRID.RANGE_COMPRESSION)
    for (const POS_ACCUM_MAX of GRID.POS_ACCUM_MAX)
      for (const POS_DIST_MIN of GRID.POS_DIST_MIN) {
        const constants = { ...REGIME_PROXY_CONSTANTS, DISPLACEMENT_TREND, RANGE_COMPRESSION, POS_ACCUM_MAX, POS_DIST_MIN };
        const m = matrixFor(constants);
        const st = matrixStats(m, samples.length);
        const rates = REGIMES.map((r) => st.perRegime[r].rate).filter((v) => v != null);
        const minRate = rates.length ? Math.min(...rates) : 0;
        const meanRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
        const entry = { constants, overall: st.overall, minRate, meanRate, matrix: m, stats: st };
        scored.push(entry);
        if (!best
          || entry.overall > best.overall + 1e-9
          || (Math.abs(entry.overall - best.overall) <= 1e-9 && entry.minRate > best.minRate + 1e-9)
          || (Math.abs(entry.overall - best.overall) <= 1e-9 && Math.abs(entry.minRate - best.minRate) <= 1e-9 && entry.meanRate > best.meanRate + 1e-9)) {
          best = entry;
        }
      }

scored.sort((a, b) => (b.overall - a.overall) || (b.minRate - a.minRate) || (b.meanRate - a.meanRate));
console.log('\nTOP 5 COMBOS (overall agreement, then balanced per-regime):');
for (const e of scored.slice(0, 5)) {
  const c = e.constants;
  console.log(`  ${(e.overall * 100).toFixed(2)}%  min=${(e.minRate * 100).toFixed(1)}%  D=${c.DISPLACEMENT_TREND} RC=${c.RANGE_COMPRESSION} PA=${c.POS_ACCUM_MAX} PD=${c.POS_DIST_MIN}`);
}

printMatrix('AFTER (winning constants)', best.matrix, best.stats);

const improved = best.overall > beforeStats.overall + 1e-9;
console.log(`\n[AM53b2] overall ${(beforeStats.overall * 100).toFixed(2)}% -> ${(best.overall * 100).toFixed(2)}%  ${improved ? 'IMPROVED' : 'NO IMPROVEMENT'}`);
console.log('[AM53b2] winning constants:', JSON.stringify({
  DISPLACEMENT_TREND: best.constants.DISPLACEMENT_TREND,
  RANGE_COMPRESSION: best.constants.RANGE_COMPRESSION,
  POS_ACCUM_MAX: best.constants.POS_ACCUM_MAX,
  POS_DIST_MIN: best.constants.POS_DIST_MIN,
}));

if (mode === 'SYNTHETIC') {
  console.log('\n[AM53b2] NOTE: synthetic mode — apply the winning constants to lib/regime-proxy.js only after a LIVE run.');
}
process.exit(improved ? 0 : 1);
