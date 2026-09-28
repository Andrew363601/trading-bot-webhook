// scripts/am53b-regime-map-block-check.mjs
// 🟢 PUSH AM53b — verifies the REGIME MAP block assembly logic is ADDITIVE-ONLY:
//   - no regime_selected  -> block is NOT emitted (byte-identical prompt)
//   - regime_selected set -> block IS emitted, with correct pct->price formula
// This replicates the inline block in hermes-brain.js (kept in sync by hand).
// Run: node scripts/am53b-regime-map-block-check.mjs

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

// --- replica of the hermes-brain.js block ---
function buildRegimeMapBlock(telemetry, marketState, candles) {
    let instructionText = '';
    const regimeGeom = telemetry?.regime_exit_geometry || null;
    const regimeSelected = regimeGeom?.regime_selected ?? telemetry?.regime_selected ?? null;
    if (regimeSelected) {
        const geom = regimeGeom || {
            regime_selected: regimeSelected,
            tp_percent: telemetry?.regime_params_applied?.tp_percent ?? null,
            sl_percent: telemetry?.regime_params_applied?.sl_percent ?? null,
            tripwire_percent: telemetry?.resolved_exit_params?.tripwire_percent ?? null,
            trail_step_percent: telemetry?.resolved_exit_params?.trail_step_percent ?? null,
            trail_activation_percent: telemetry?.resolved_exit_params?.trail_activation_percent ?? null,
            source: (telemetry?.regime_params_applied && Object.keys(telemetry.regime_params_applied).length > 0) ? 'map' : 'base'
        };
        const fmtPct = (v) => (v != null ? `${(parseFloat(v) * 100).toFixed(2)}%` : '—');
        const entryPx = marketState?.result?.current_price
            || marketState?.current_price
            || (candles && candles.length > 0 ? candles[candles.length - 1].close : null);
        const entryPxStr = entryPx != null ? `$${entryPx}` : 'the signal entry price';
        const srcNote = geom.source === 'map'
            ? 'from the strategy\'s regime map (governing)'
            : 'BASE fallback — the map had no entry for this regime';
        instructionText += `--- REGIME MAP (governing exit geometry) ---
Regime selected: ${regimeSelected} (${srcNote})
Mapped exits: TP ${fmtPct(geom.tp_percent)} | SL ${fmtPct(geom.sl_percent)} | tripwire ${fmtPct(geom.tripwire_percent)} | trail step ${fmtPct(geom.trail_step_percent)} | trail activation ${fmtPct(geom.trail_activation_percent)}
These percentages are the GOVERNING exit geometry for this entry. Your tp_price/sl_price MUST implement them, converted to price from the signal entry price (${entryPxStr}):
  LONG:  tp_price = entry × (1 + tp_percent)   |  sl_price = entry × (1 − sl_percent)
  SHORT: tp_price = entry × (1 − tp_percent)   |  sl_price = entry × (1 + sl_percent)
You retain override authority as risk manager: if live context (cascade, funding shock, liquidity gap) demands different prices, you may override — but the override MUST be stated in your reasoning as 'REGIME OVERRIDE: <why>' so it lands in the audit trail.

`;
    }
    return instructionText;
}

// 1) No-map strategy: telemetry has no regime_selected -> NO block.
const noMap = buildRegimeMapBlock({ price: '100.00', macro_regime_oracle: 'CHOP' }, {}, []);
ok('no-map: block is empty (byte-identical prompt)', noMap === '');

// 2) telemetry undefined entirely -> NO block, no throw.
let threw = false;
let undefOut = '';
try { undefOut = buildRegimeMapBlock(undefined, undefined, undefined); } catch (e) { threw = true; }
ok('undefined telemetry: no throw', !threw);
ok('undefined telemetry: block is empty', undefOut === '');

// 3) CHOP map hit -> block emitted, source=map, formula present.
const chopMap = buildRegimeMapBlock({
    regime_selected: 'CHOP',
    regime_exit_geometry: { regime_selected: 'CHOP', tp_percent: 0.025, sl_percent: 0.012, tripwire_percent: 0.006, trail_step_percent: 0.003, trail_activation_percent: 0.01, source: 'map' }
}, { result: { current_price: 2.5 } }, []);
ok('map hit: block emitted', chopMap.includes('--- REGIME MAP (governing exit geometry) ---'));
ok('map hit: regime cited', chopMap.includes('Regime selected: CHOP'));
ok('map hit: source=map note', chopMap.includes('regime map (governing)'));
ok('map hit: TP 2.50%', chopMap.includes('TP 2.50%'));
ok('map hit: SL 1.20%', chopMap.includes('SL 1.20%'));
ok('map hit: entry price rendered', chopMap.includes('$2.5'));
ok('map hit: LONG formula', chopMap.includes('LONG:  tp_price = entry × (1 + tp_percent)'));
ok('map hit: SHORT formula', chopMap.includes('SHORT: tp_price = entry × (1 − tp_percent)'));
ok('map hit: REGIME OVERRIDE audit rule', chopMap.includes("REGIME OVERRIDE: <why>"));

// 4) TREND entry, map has no TREND entry -> regime_selected recorded, source=base.
const trendGap = buildRegimeMapBlock({
    regime_selected: 'TREND',
    regime_params_applied: {},
    resolved_exit_params: { tripwire_percent: 0.005, trail_step_percent: 0.002, trail_activation_percent: null }
}, { result: { current_price: 100 } }, []);
ok('map gap: block emitted (regime recorded)', trendGap.includes('Regime selected: TREND'));
ok('map gap: source=base note', trendGap.includes('BASE fallback'));
ok('map gap: tp/sl show — (not in map)', trendGap.includes('TP — | SL —'));

// 5) Fallback path: no regime_exit_geometry but regime_selected + applied present.
const legacy = buildRegimeMapBlock({
    regime_selected: 'CHOP',
    regime_params_applied: { tp_percent: 0.025, sl_percent: 0.012 },
    resolved_exit_params: { tripwire_percent: 0.006, trail_step_percent: 0.003 }
}, { result: { current_price: 2.5 } }, []);
ok('legacy fallback: block emitted', legacy.includes('--- REGIME MAP'));
ok('legacy fallback: source=map (applied non-empty)', legacy.includes('regime map (governing)'));
ok('legacy fallback: TP 2.50%', legacy.includes('TP 2.50%'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
