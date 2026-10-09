// scripts/am62-loop-health-check.mjs
// 🟢 PUSH AM62 — units for lib/loop-health.js (weekly bucketing, rolling-20,
// honesty gap). Also asserts the pre-059 safety nets + the gate-honesty wiring.
// Run: node scripts/am62-loop-health-check.mjs
import { readFileSync } from 'node:fs';
import { deriveLoopHealth, isoWeekKey } from '../lib/loop-health.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

console.log('\n[1] isoWeekKey — Monday-anchored UTC');
{
  ok('Wed 2026-10-07 -> Mon 2026-10-05', isoWeekKey('2026-10-07T12:00:00Z') === '2026-10-05');
  ok('Mon 2026-10-05 -> itself', isoWeekKey('2026-10-05T00:00:00Z') === '2026-10-05');
  ok('Sun 2026-10-11 -> Mon 2026-10-05', isoWeekKey('2026-10-11T23:59:00Z') === '2026-10-05');
  ok('invalid -> null', isoWeekKey('not-a-date') === null);
}

console.log('\n[2] deriveLoopHealth — weekly buckets, wins, predicted, agent_adjusted');
{
  const trades = [
    { pnl: 10, exit_time: '2026-09-28T10:00:00Z', model_predicted_win_prob: 0.8, params_context: { agent_adjusted: true }, structure_direction: 'LONG' },
    { pnl: -5, exit_time: '2026-09-29T10:00:00Z', model_predicted_win_prob: 0.6, structure_direction: 'SHORT' },
    { pnl: 20, exit_time: '2026-10-05T10:00:00Z', model_predicted_win_prob: 0.7, structure_direction: 'LONG' },
  ];
  const lessons = [
    { created_at: '2026-09-28T12:00:00Z', lesson_score: 80 },
    { created_at: '2026-10-05T12:00:00Z', lesson_score: 60 },
  ];
  const r = deriveLoopHealth(trades, lessons);
  ok('two week buckets', r.weeks.length === 2);
  ok('w1 n=2', r.weeks[0].n === 2);
  ok('w1 win_rate 50', r.weeks[0].win_rate === 50);
  ok('w1 avg_predicted 70', r.weeks[0].avg_predicted_prob === 70);
  ok('w1 agent_adjusted 1', r.weeks[0].agent_adjusted_count === 1);
  ok('w1 cumulative_pnl 5', r.weeks[0].cumulative_pnl === 5);
  ok('w2 cumulative_pnl 25', r.weeks[1].cumulative_pnl === 25);
  ok('w1 lessons 1 avg 80', r.weeks[0].lessons_written === 1 && r.weeks[0].avg_score === 80);
  ok('w2 lessons 1 avg 60', r.weeks[1].lessons_written === 1 && r.weeks[1].avg_score === 60);
  ok('structure tallies', r.weeks[0].structure.LONG === 1 && r.weeks[0].structure.SHORT === 1);
  ok('rolling20 present', r.weeks[0].rolling20 === 50);
  ok('series.realized 2 pts', r.series.realized.length === 2);
  ok('series.lessons weekly', r.series.lessons.length === 2);
}

console.log('\n[3] honesty gap = weighted predicted − realized');
{
  const trades = [
    { pnl: 10, exit_time: '2026-09-28T10:00:00Z', model_predicted_win_prob: 0.9 },
    { pnl: -5, exit_time: '2026-09-29T10:00:00Z', model_predicted_win_prob: 0.9 },
  ];
  const r = deriveLoopHealth(trades, []);
  ok('realized 50', r.totals.win_rate === 50);
  ok('predicted 90', r.totals.predicted_prob === 90);
  ok('honesty_gap +40', r.totals.honesty_gap === 40);
}

console.log('\n[4] empty input -> honest empty (no crash)');
{
  const r = deriveLoopHealth([], []);
  ok('no weeks', r.weeks.length === 0);
  ok('trades 0', r.totals.trades === 0);
  ok('win_rate null (not 0)', r.totals.win_rate === null);
  ok('honesty_gap null', r.totals.honesty_gap === null);
  ok('realized series empty', r.series.realized.length === 0);
}

console.log('\n[5] rolling-20 uses a trailing window over the chronological stream');
{
  const trades = [];
  for (let i = 0; i < 25; i++) {
    trades.push({ pnl: i < 20 ? 1 : -1, exit_time: `2026-10-0${(i % 5) + 5}T0${i % 9}:00:00Z` });
  }
  // Ordering by exit_time isn't guaranteed here; derive uses array order.
  const r = deriveLoopHealth(trades, []);
  ok('some rolling20 emitted', Object.keys(r.series).length > 0 && r.series.rolling20.length > 0);
  ok('rolling20 bounded 0..100', r.series.rolling20.every(p => p.value >= 0 && p.value <= 100));
}

console.log('\n[6] safety nets + gate-honesty wiring (source assertions)');
{
  const exec = readFileSync(new URL('../lib/execute-trade-mcp.js', import.meta.url), 'utf8');
  ok('entry retry drops structure_direction', /delete without\.structure_direction/.test(exec));
  ok('entry write stamps structure_direction', /structure_direction: structureDirection/.test(exec));
  ok('close write stamps structure_direction', /structure_direction: deriveStructureDirection/.test(exec));
  ok('params_context mirror', /entryParamsContext\.structure_direction = structureDirection/.test(exec));

  const brain = readFileSync(new URL('../hermes-brain.js', import.meta.url), 'utf8');
  ok('forcedRiskClose flag read', /forcedRiskClose = forced_risk_close === true/.test(brain));
  ok('CLOSE gate downgrades to HOLD', /downgrading CLOSE to HOLD/.test(brain));
  ok('gate uses final actionable var', /isActionableExecutionFinal \|\| decisionJson\.action === "ADJUST_TP_SL"/.test(brain));
  ok('lesson_score safety net', /lesson_score.*column rejected/s.test(brain));
  ok('settings fetch hoisted (entry_adjust read)', /agent_open_trade_entry_adjust, agent_taker_fee_rate/.test(brain));

  const wd = readFileSync(new URL('../workers/watchdog.js', import.meta.url), 'utf8');
  ok('tripwire wake carries authorization', /forced_risk_close: true/.test(wd) && /authorization: 'TRIPWIRE_RISK_CLOSE'/.test(wd));

  const settings = readFileSync(new URL('../pages/settings.js', import.meta.url), 'utf8');
  ok('panel acknowledges forced risk close', /forced risk close/.test(settings));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
