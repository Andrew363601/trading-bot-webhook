// lib/regime-params.js
// 🟢 PUSH AM53 — regime-conditional execution params.
//
// A deployed strategy's `parameters` object MAY carry a per-regime exit map:
//
//   parameters.regime_params = {
//     TREND:        { tp_percent, sl_percent, tripwire_percent, trail_step_percent },
//     CHOP:         { ... },
//     ACCUMULATION: { ... },
//     DISTRIBUTION: { ... }
//   }
//
// The sniper resolves the map from the TF-invariant CANON regime at SIGNAL time
// and locks the resolved geometry at ENTRY. An open position NEVER re-reads the
// map — regime changes mid-trade do not retune it.
//
// Sizing/leverage stay GLOBAL (risk is regime-independent; exits are
// regime-tuned). Only the exit keys below may appear inside a regime entry.
//
// Pure module — no I/O, no side effects.

export const REGIME_KEYS = ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'];

// Exit geometry ONLY. Anything else (leverage/qty/market_type/macro_tf/
// trigger_tf/veto_cooldown_minutes/...) is global and must NOT be per-regime.
export const REGIME_PARAM_KEYS = ['tp_percent', 'sl_percent', 'tripwire_percent', 'trail_step_percent'];

const EXIT_KEYS_TEXT = REGIME_PARAM_KEYS.join(', ');

/**
 * Structural validation of a `regime_params` map. Pure. Regime-independent —
 * this is what the deploy gate calls (a deploy dry-check must be able to reject
 * a bad map WITHOUT knowing today's canon regime).
 *
 * @param {*} map the raw `parameters.regime_params` value (may be undefined/null)
 * @returns {true} when the map is absent or structurally valid
 * @throws {{ error: string }} loud error on any invalid key/value
 */
export function validateRegimeParamsMap(map) {
  // Absent map is valid (feature simply unused).
  if (map === undefined || map === null) return true;

  if (typeof map !== 'object' || Array.isArray(map)) {
    throw { error: `regime_params must be an object keyed by regime (exit keys only: ${EXIT_KEYS_TEXT})` };
  }

  for (const regimeKey of Object.keys(map)) {
    if (!REGIME_KEYS.includes(regimeKey)) {
      throw { error: `regime_params.${regimeKey} is not a known regime (allowed: ${REGIME_KEYS.join(', ')})` };
    }
    const entry = map[regimeKey];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw { error: `regime_params.${regimeKey} must be an object (exit keys only: ${EXIT_KEYS_TEXT})` };
    }
    for (const paramKey of Object.keys(entry)) {
      if (!REGIME_PARAM_KEYS.includes(paramKey)) {
        throw { error: `regime_params.${regimeKey}.${paramKey} not allowed (exit keys only: ${EXIT_KEYS_TEXT})` };
      }
    }
  }
  return true;
}

/**
 * Resolve the exit params for one entry from the canon regime.
 *
 * Rules (AM53 spec):
 *  1. No `regime_params` on the config, or canonRegime null/unknown
 *     -> { params: base, regime_selected: null, overrides_applied: {} }.
 *  2. Validate the map; invalid key -> THROW loud (never silently trade base).
 *  3. Regime missing from the map -> fall back to base but RECORD the gap:
 *     { params: base, regime_selected: canonRegime, overrides_applied: {} }.
 *  4. Merge { ...base, ...map[canonRegime] } ->
 *     { params, regime_selected, overrides_applied }.
 *
 * Pure, no I/O. Called ONCE per entry — never mid-trade.
 *
 * @param {object} baseParameters the strategy's `parameters` object
 * @param {string|null} canonRegime TF-invariant canon label the sniper computes
 * @returns {{ params: object, regime_selected: string|null, overrides_applied: object }}
 */
export function resolveRegimeParams(baseParameters, canonRegime) {
  const base = (baseParameters && typeof baseParameters === 'object') ? baseParameters : {};
  const map = base.regime_params;

  // Rule 1 — feature unused, or no usable regime label.
  if (map === undefined || map === null) {
    return { params: base, regime_selected: null, overrides_applied: {} };
  }
  if (!canonRegime || !REGIME_KEYS.includes(canonRegime)) {
    // Still validate structurally so a broken map surfaces even on an
    // unclassifiable bar — fail loud rather than trade on base silently.
    validateRegimeParamsMap(map);
    return { params: base, regime_selected: null, overrides_applied: {} };
  }

  // Rule 2 — structural validation (throws loud on any invalid key).
  validateRegimeParamsMap(map);

  // Rule 3 — gap in the map: base params, but record that the regime was seen.
  const regimeParams = map[canonRegime];
  if (regimeParams === undefined || regimeParams === null) {
    return { params: base, regime_selected: canonRegime, overrides_applied: {} };
  }

  // Rule 4 — merge exit overrides over the base set.
  const overrides = {};
  for (const k of REGIME_PARAM_KEYS) {
    if (regimeParams[k] !== undefined && regimeParams[k] !== null) overrides[k] = regimeParams[k];
  }
  return {
    params: { ...base, ...overrides },
    regime_selected: canonRegime,
    overrides_applied: overrides
  };
}

const regimeParams = { REGIME_KEYS, REGIME_PARAM_KEYS, validateRegimeParamsMap, resolveRegimeParams };
export default regimeParams;
