// scripts/am53-regime-params-check.mjs
// 🟢 PUSH AM53 — unit checks for lib/regime-params.js.
// Run: node scripts/am53-regime-params-check.mjs
import { REGIME_KEYS, REGIME_PARAM_KEYS, validateRegimeParamsMap, resolveRegimeParams } from '../lib/regime-params.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}
function throws(name, fn, matcher) {
  try { fn(); fail++; console.error(`  ❌ ${name} (did not throw)`); }
  catch (e) {
    const msg = e?.error || e?.message || String(e);
    if (matcher && !matcher.test(msg)) { fail++; console.error(`  ❌ ${name} (wrong message: ${msg})`); }
    else { pass++; console.log(`  ✅ ${name} -> "${msg}"`); }
  }
}

const base = { tp_percent: 0.02, sl_percent: 0.01, tripwire_percent: 0.005, trail_step_percent: 0.002, leverage: 10, qty: 1 };

console.log('\n[1] no map -> base, regime_selected null');
{
  const r = resolveRegimeParams(base, 'CHOP');
  ok('params === base', r.params === base);
  ok('regime_selected null', r.regime_selected === null);
  ok('overrides_applied {}', Object.keys(r.overrides_applied).length === 0);
}

console.log('\n[2] CHOP map -> merged overrides');
{
  const cfg = { ...base, regime_params: { CHOP: { tp_percent: 0.01, sl_percent: 0.005 } } };
  const r = resolveRegimeParams(cfg, 'CHOP');
  ok('regime_selected CHOP', r.regime_selected === 'CHOP');
  ok('tp overridden', r.params.tp_percent === 0.01);
  ok('sl overridden', r.params.sl_percent === 0.005);
  ok('tripwire inherited from base', r.params.tripwire_percent === 0.005);
  ok('leverage untouched (global)', r.params.leverage === 10);
  ok('overrides_applied has 2 keys', Object.keys(r.overrides_applied).length === 2);
}

console.log('\n[3] invalid key -> throws loud');
{
  const cfg = { ...base, regime_params: { CHOP: { leverage: 50 } } };
  throws('leverage inside regime entry rejected', () => resolveRegimeParams(cfg, 'CHOP'), /regime_params\.CHOP\.leverage not allowed/);
  throws('validateRegimeParamsMap rejects directly', () => validateRegimeParamsMap({ CHOP: { leverage: 50 } }), /not allowed/);
  throws('unknown regime key rejected', () => validateRegimeParamsMap({ MOON: { tp_percent: 0.1 } }), /not a known regime/);
  throws('non-object map rejected', () => validateRegimeParamsMap([1, 2]), /must be an object/);
}

console.log('\n[4] missing regime -> base fallback but RECORDED');
{
  const cfg = { ...base, regime_params: { TREND: { tp_percent: 0.05 } } };
  const r = resolveRegimeParams(cfg, 'CHOP');
  ok('params === cfg (base set)', r.params === cfg);
  ok('tp NOT overridden', r.params.tp_percent === 0.02);
  ok('regime_selected CHOP (gap recorded)', r.regime_selected === 'CHOP');
  ok('overrides_applied {}', Object.keys(r.overrides_applied).length === 0);
}

console.log('\n[5] null/unknown regime -> base, no selection');
{
  const cfg = { ...base, regime_params: { CHOP: { tp_percent: 0.01 } } };
  const r1 = resolveRegimeParams(cfg, null);
  ok('null regime -> base', r1.params === cfg && r1.regime_selected === null);
  const r2 = resolveRegimeParams(cfg, 'MOON');
  ok('unknown regime -> base', r2.params === cfg && r2.regime_selected === null);
  // but a BROKEN map must still throw even with a null regime
  throws('broken map throws even with null regime', () => resolveRegimeParams({ ...base, regime_params: { CHOP: { qty: 5 } } }, null), /not allowed/);
}

console.log('\n[6] constants');
{
  ok('REGIME_KEYS', JSON.stringify(REGIME_KEYS) === JSON.stringify(['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION']));
  ok('REGIME_PARAM_KEYS', JSON.stringify(REGIME_PARAM_KEYS) === JSON.stringify(['tp_percent', 'sl_percent', 'tripwire_percent', 'trail_step_percent']));
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
