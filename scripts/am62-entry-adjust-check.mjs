// scripts/am62-entry-adjust-check.mjs
// 🟢 PUSH AM62 — units for lib/entry-adjust.js + structure_direction derivation.
// Run: node scripts/am62-entry-adjust-check.mjs
import { resolveEntryAdjust, clampEntryProposal, ABS_MIN, ABS_MAX, ENTRY_ADJUST_FIELDS } from '../lib/entry-adjust.js';
import { computeLessonScore } from '../lib/mistake-learning.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// Mirror of the derivation in lib/execute-trade-mcp.js (kept in sync by hand;
// the endpoint/lib has no exported copy so we re-assert the contract here).
function deriveStructureDirection(regime, cvd) {
  const r = String(regime || '').toUpperCase();
  const regimeBias = (r === 'TREND' || r === 'ACCUMULATION') ? 'LONG'
    : (r === 'DISTRIBUTION') ? 'SHORT' : null;
  const c = parseFloat(cvd);
  const cvdBias = Number.isFinite(c) && c !== 0 ? (c > 0 ? 'LONG' : 'SHORT') : null;
  if (regimeBias && cvdBias) return regimeBias === cvdBias ? regimeBias : 'NEUTRAL';
  return regimeBias || cvdBias || 'NEUTRAL';
}

console.log('\n[1] resolveEntryAdjust — OFF (no proposals) is inert');
{
  const r = resolveEntryAdjust(null);
  ok('null proposals -> agent_adjusted false', r.agent_adjusted === false);
  ok('null proposals -> applied empty', Object.keys(r.applied).length === 0);
  ok('null proposals -> not clamped', r.clamped === false);
  const r2 = resolveEntryAdjust({});
  ok('empty proposals -> inert', r2.agent_adjusted === false && r2.clamped === false);
  ok('unparseable proposals -> inert', resolveEntryAdjust({ tp_percent: 'abc' }).agent_adjusted === false);
}

console.log('\n[2] resolveEntryAdjust — ON + in-bounds proposal -> applied, not clamped');
{
  const r = resolveEntryAdjust({ tp_percent: 0.03, sl_percent: 0.015, tripwire_percent: 0.004, trail_step_percent: 0.002 });
  ok('agent_adjusted true', r.agent_adjusted === true);
  ok('all four applied', ENTRY_ADJUST_FIELDS.every(f => r.applied[f] != null));
  ok('tp applied = 0.03', r.applied.tp_percent === 0.03);
  ok('not clamped', r.clamped === false);
  ok('no details', r.details.length === 0);
}

console.log('\n[3] resolveEntryAdjust — ON + out-of-bounds -> clamped + truthful message');
{
  const r = resolveEntryAdjust({ tp_percent: 0.95, sl_percent: 0.0000001 });
  ok('tp clamped to ABS_MAX', r.applied.tp_percent === ABS_MAX);
  ok('sl clamped to ABS_MIN', r.applied.sl_percent === ABS_MIN);
  ok('clamped true', r.clamped === true);
  ok('details mention tp', r.details.some(d => /tp_percent clamped/.test(d)));
  ok('details mention bounds', r.details.some(d => /bounds/.test(d)));
}

console.log('\n[4] clampEntryProposal — config min/max override absolute limits');
{
  const p = clampEntryProposal('tp_percent', 0.10, { tp_percent_max: 0.04 });
  ok('custom max wins', p.applied === 0.04);
  ok('reports custom max', p.max === 0.04);
  const p2 = clampEntryProposal('sl_percent', 0.001, { sl_percent_min: 0.01 });
  ok('custom min wins', p2.applied === 0.01);
  ok('reports custom min', p2.min === 0.01);
  const p3 = clampEntryProposal('tripwire_percent', 0.004, {});
  ok('absolute fallback bounds', p3.min === ABS_MIN && p3.max === ABS_MAX);
  ok('absent proposal -> null', clampEntryProposal('tp_percent', undefined) === null);
}

console.log('\n[5] structure_direction derivation');
{
  ok('TREND + positive CVD -> LONG', deriveStructureDirection('TREND', '120') === 'LONG');
  ok('DISTRIBUTION + negative CVD -> SHORT', deriveStructureDirection('DISTRIBUTION', '-50') === 'SHORT');
  ok('TREND + negative CVD -> conflict -> NEUTRAL', deriveStructureDirection('TREND', '-50') === 'NEUTRAL');
  ok('ACCUMULATION + positive -> LONG', deriveStructureDirection('ACCUMULATION', '5') === 'LONG');
  ok('CHOP + positive -> CVD bias LONG', deriveStructureDirection('CHOP', '5') === 'LONG');
  ok('CHOP + zero -> NEUTRAL', deriveStructureDirection('CHOP', '0') === 'NEUTRAL');
  ok('EVALUATING + null -> NEUTRAL', deriveStructureDirection('EVALUATING', null) === 'NEUTRAL');
  ok('never null for a new row', deriveStructureDirection(null, null) === 'NEUTRAL');
}

console.log('\n[6] computeLessonScore — deterministic, bounded, descriptive penalty');
{
  const now = Date.parse('2026-10-08T00:00:00Z');
  const fresh = computeLessonScore({ created_at: new Date(now).toISOString(), pnl: 0, win_loss: 'WIN', execution_mode: 'PAPER', tags: [] }, now);
  ok('fresh neutral score finite', Number.isFinite(fresh));
  const loss = computeLessonScore({ created_at: new Date(now).toISOString(), pnl: -300, win_loss: 'LOSS', execution_mode: 'LIVE', thesis_accurate: true, tags: ['WALL_REJECTION'] }, now);
  ok('loss+lIVE outranks fresh', loss > fresh);
  const descriptive = computeLessonScore({ created_at: new Date(now).toISOString(), pnl: -300, win_loss: 'LOSS', execution_mode: 'LIVE', thesis_accurate: true, tags: ['DESCRIPTIVE_ONLY'] }, now);
  ok('descriptive penalized below tagged', descriptive < loss);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
