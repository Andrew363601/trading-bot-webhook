// AM58 C5 — watchdog liveness unit checks.
//  7a: concurrent sweep calls -> second logs 'skipped, in flight'.
//  7c: 15min silence -> alert fires ONCE, not repeated; re-armed on success.
//
// Run: node scripts/am58-watchdog-liveness-check.mjs
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  sweepOpenTrades,
  watchdogLivenessTick,
  markSweepSuccess,
  isSweepInFlight,
  __setSweepInFlight,
} = await import('../workers/watchdog.js');

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

// ── 7a: overlap guard ──
{
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  __setSweepInFlight('t-overlap', true);
  await sweepOpenTrades('t-overlap'); // guard hit -> returns before any I/O
  console.log = origLog;
  check('7a second sweep logs skipped, in flight', logs.some(l => /skipped, in flight/.test(l)), logs.join(' | '));
  check('7a guard flag still set (returned before finally)', isSweepInFlight('t-overlap'));
  __setSweepInFlight('t-overlap', false);
  check('7a flag cleared', !isSweepInFlight('t-overlap'));
}

// ── 7c: dead-man switch ──
{
  const t = 't-liveness';
  const t0 = 1_700_000_000_000;
  check('7c no baseline -> no alert', watchdogLivenessTick(t, t0).alert === false);

  markSweepSuccess(t, t0);
  const first = watchdogLivenessTick(t, t0 + 16 * 60 * 1000);
  check('7c 16min silence -> alert fires', first.alert === true && first.mins === 16, JSON.stringify(first));

  const second = watchdogLivenessTick(t, t0 + 17 * 60 * 1000);
  check('7c alert does NOT repeat', second.alert === false, JSON.stringify(second));

  markSweepSuccess(t, t0 + 18 * 60 * 1000);
  const third = watchdogLivenessTick(t, t0 + 40 * 60 * 1000);
  check('7c re-armed after success -> alerts again', third.alert === true, JSON.stringify(third));

  const under = watchdogLivenessTick(t, t0 + 18 * 60 * 1000 + 5 * 60 * 1000);
  check('7c under threshold -> no alert', under.alert === false, JSON.stringify(under));
}

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
