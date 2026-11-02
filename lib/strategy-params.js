// lib/strategy-params.js
// 🟢 AM72 — the CANONICAL end-user parameters schema for strategy_config.parameters.
//
// ONE source of truth for:
//   • which keys the blob may carry (CANONICAL_PARAM_KEYS)
//   • which keys are LEGACY / duplicate-truth and must be stripped on every write
//     (LEGACY_PARAM_KEYS) — scrubbed from existing rows by migration 064
//
// The blob is END-USER config only. Brain-owned state (regime maps, agent_adjusted
// flags, trap geometry, etc.) is written by the engine and is NOT in this list —
// sanitizeParameters() only removes the KNOWN legacy keys, it never whitelists.
//
// execution_mode is NOT a blob key: the strategy_config.execution_mode COLUMN is
// the ONLY mode source (AM72 single-mode-truth). market_type is NOT a blob key:
// it is DERIVED from the venue at the trade stamp (krakenspot → SPOT, else FUTURES).

// The canonical end-user schema. Unit semantics (AM70-hf1):
//   qty                    — base units (number)
//   leverage               — number (1 = cash / no leverage)
//   macro_tf / trigger_tf  — enum (Coinbase granularity strings)
//   tp_percent / sl_percent— PRICE % (decimal, e.g. 0.05 = 5%)
//   tripwire_percent       — ROE % (decimal)
//   trail_step_percent     — ROE % (decimal)
//   veto_cooldown_minutes  — integer minutes
export const CANONICAL_PARAM_KEYS = [
  'qty',
  'leverage',
  'macro_tf',
  'trigger_tf',
  'tp_percent',
  'sl_percent',
  'tripwire_percent',
  'trail_step_percent',
  'veto_cooldown_minutes',
];

// Legacy / duplicate-truth keys that older write paths (and two client call sites)
// leaked into the blob. Stripped on every write path; scrubbed from existing rows
// by supabase/migrations/064-scrub-strategy-params.sql.
export const LEGACY_PARAM_KEYS = [
  'quantity',        // UI label only; no loader ever read it
  'stop_loss_pct',   // UI label only; canonical is sl_percent
  'take_profit_pct', // UI label only; canonical is tp_percent
  'market_type',     // now derived from the venue at the trade stamp
  'execution_mode',  // the strategy_config.execution_mode COLUMN is the only mode
];

const LEGACY_SET = new Set(LEGACY_PARAM_KEYS);

/**
 * Remove the known legacy keys from a parameters blob. Returns a NEW object; the
 * input is never mutated. Non-object input → {}.
 *
 * This is a DENY-list (strip known-bad), NOT an allow-list — brain-owned keys the
 * engine writes (regime_params, agent_adjusted, trap_*, …) pass through untouched.
 */
export function sanitizeParameters(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return {};
  const out = {};
  for (const key of Object.keys(blob)) {
    if (LEGACY_SET.has(key)) continue;
    out[key] = blob[key];
  }
  return out;
}

/**
 * Keep ONLY the canonical end-user keys from a blob. Returns a NEW object.
 * Use when a caller must be constrained to the canonical schema (e.g. a UI-owned
 * merge); use sanitizeParameters() when brain-owned keys must survive.
 */
export function pickCanonical(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return {};
  const out = {};
  for (const key of CANONICAL_PARAM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(blob, key)) out[key] = blob[key];
  }
  return out;
}

/** True when the blob carries any legacy key (used by gates / diagnostics). */
export function hasLegacyParams(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false;
  return Object.keys(blob).some((k) => LEGACY_SET.has(k));
}
