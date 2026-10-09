// scripts/am62b-backfill-structure.mjs
// 🟢 PUSH AM62b — one-off backfill of trade_logs.structure_direction for recent
// rows that predate the v2 resolver (column still NULL). Re-derives each row from
// its stored market_snapshot_at_entry CVD + candles-at-entry on the row's macro TF.
//
// SAFE BY DEFAULT: dry-run (prints counts, writes nothing). Pass --apply to write.
// NULL-ONLY: never touches a row that already has a structure_direction.
// SKIP-NO-CVD: rows whose entry snapshot carries no CVD field are skipped.
//
// Run:
//   node scripts/am62b-backfill-structure.mjs                       # dry-run, 30d
//   node scripts/am62b-backfill-structure.mjs --apply
//   node scripts/am62b-backfill-structure.mjs --days 90 --tenant <uuid> --apply
import { createClient } from '@supabase/supabase-js';
import { fetchCandles, resolveGranularity } from '../lib/candles.js';
import { deriveStructureDirection, MIN_BARS } from '../lib/structure-direction.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = has('--apply');
const DAYS = parseInt(val('--days', '30'), 10);
const TENANT = val('--tenant', null);
const ROW_CAP = 50000;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('[AM62b backfill] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('  Set them (service role) and re-run. Nothing was written.');
  process.exit(0);
}
const supabase = createClient(url, key);

// Entry-snapshot CVD, in the same priority order the live path uses.
const cvdOf = (snap) => {
  if (!snap || typeof snap !== 'object') return null;
  const v = snap.macro_cvd ?? snap.cvd ?? snap.micro_cvd;
  return (v === undefined || v === null || v === '') ? null : v;
};

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  let q = supabase.from('trade_logs')
    .select('id, symbol, macro_tf, created_at, market_snapshot_at_entry')
    .is('structure_direction', null)
    .not('market_snapshot_at_entry', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(ROW_CAP);
  if (TENANT) q = q.eq('tenant_id', TENANT);
  const { data: rows, error } = await q;
  if (error) { console.error('[AM62b backfill] query failed:', error.message); process.exit(1); }

  const stats = { scanned: rows.length, updated: 0, would_update: 0, skipped_no_cvd: 0, skipped_no_candles: 0, failed: 0 };
  console.log(`[AM62b backfill] ${APPLY ? 'APPLY' : 'DRY-RUN'} · ${rows.length} NULL rows in last ${DAYS}d${TENANT ? ` · tenant ${TENANT}` : ''}`);

  // Group by symbol + macro_tf so each group fetches its candle window once.
  const groups = new Map();
  for (const r of rows) {
    const tf = r.macro_tf || 'ONE_HOUR';
    const k = `${r.symbol}|${tf}`;
    if (!groups.has(k)) groups.set(k, { symbol: r.symbol, tf, rows: [] });
    groups.get(k).rows.push(r);
  }

  for (const g of groups.values()) {
    const { granularitySeconds: stepSec } = resolveGranularity(g.tf);
    const times = g.rows.map((r) => Math.floor(new Date(r.created_at).getTime() / 1000)).filter(Number.isFinite);
    if (times.length === 0) continue;
    const minT = Math.min(...times), maxT = Math.max(...times);
    const startEpoch = minT - stepSec * (MIN_BARS + 2);
    const endEpoch = maxT + stepSec;
    let candles = [];
    try {
      candles = await fetchCandles({ product: g.symbol, granularitySeconds: stepSec, startEpoch, endEpoch });
    } catch (e) {
      console.warn(`[AM62b backfill] candle fetch failed for ${g.symbol} @${g.tf}: ${e.message}`);
    }
    console.log(`  · ${g.symbol} @${g.tf}: ${g.rows.length} rows, ${candles.length} candles`);

    for (const r of g.rows) {
      const cvd = cvdOf(r.market_snapshot_at_entry);
      if (cvd === null) { stats.skipped_no_cvd++; continue; }
      const t = Math.floor(new Date(r.created_at).getTime() / 1000);
      const slice = candles.filter((c) => c.time <= t);
      if (slice.length < MIN_BARS) { stats.skipped_no_candles++; continue; }
      const dir = deriveStructureDirection(slice, cvd);
      if (!APPLY) { stats.would_update++; continue; }
      // .is(null) keeps the write NULL-ONLY even under a concurrent fill.
      const { error: uErr } = await supabase.from('trade_logs')
        .update({ structure_direction: dir })
        .eq('id', r.id)
        .is('structure_direction', null);
      if (uErr) { stats.failed++; console.warn(`    ! update ${r.id} failed: ${uErr.message}`); }
      else stats.updated++;
    }
  }

  console.log('\n[AM62b backfill] summary');
  console.log(`  scanned         : ${stats.scanned}`);
  console.log(`  ${APPLY ? 'updated' : 'would update'}        : ${APPLY ? stats.updated : stats.would_update}`);
  console.log(`  skipped no-CVD  : ${stats.skipped_no_cvd}`);
  console.log(`  skipped no-cand : ${stats.skipped_no_candles}`);
  if (APPLY) console.log(`  failed          : ${stats.failed}`);
  if (!APPLY) console.log('\n  (dry-run — re-run with --apply to write)');
}

main().catch((e) => { console.error('[AM62b backfill] fatal:', e.message); process.exit(1); });
