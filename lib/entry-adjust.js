// lib/entry-adjust.js
// 🟢 PUSH AM62 — bounded agent entry-geometry proposals (PURE, no I/O).
//
// When tenant_settings.agent_open_trade_entry_adjust is ON, the brain may return
// action "APPROVE_WITH_PARAMS": the agent proposes THIS entry's exit geometry
// (tp_percent / sl_percent / tripwire_percent / trail_step_percent, as DECIMALS)
// instead of inheriting the saved strategy config. This module clamps each
// proposal to bounds and reports a TRUTHFUL "proposed -> applied" message.
//
// Bounds resolution, per field:
//   1. optional config keys  <field>_min / <field>_max  (e.g. tp_percent_min)
//   2. else absolute sane limits  [ABS_MIN, ABS_MAX] = [0.0001, 0.20]  (0.01%–20%)
// The absolute limits mirror hermes-brain.js normalizePercent so a proposal can
// never exceed the flat guard the brain already applies to config writes.
//
// Doctrine: additive. With no proposals the caller takes the DEFAULT path and
// nothing here runs — the am53c regression guard must stay byte-identical.

export const ENTRY_ADJUST_FIELDS = ['tp_percent', 'sl_percent', 'tripwire_percent', 'trail_step_percent'];

// Absolute sane fallback when the config carries no per-field min/max.
export const ABS_MIN = 0.0001; // 0.01%
export const ABS_MAX = 0.20;   // 20%

function toNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Clamp ONE percent proposal. Returns { field, proposed, applied, clamped, min, max }
// or null when the proposal is absent/unparseable.
export function clampEntryProposal(field, rawProposed, cfgParams = {}) {
  const proposed = toNum(rawProposed);
  if (proposed === null) return null;

  const cfgMin = toNum(cfgParams[`${field}_min`]);
  const cfgMax = toNum(cfgParams[`${field}_max`]);
  const min = cfgMin !== null ? cfgMin : ABS_MIN;
  const max = cfgMax !== null ? cfgMax : ABS_MAX;

  let applied = proposed;
  if (applied < min) applied = min;
  if (applied > max) applied = max;

  // Keep a sane precision (6dp) so stored geometry is not a float-noise mess.
  applied = Math.round(applied * 1e6) / 1e6;

  return {
    field,
    proposed,
    applied,
    clamped: applied !== proposed,
    min,
    max,
  };
}

// Resolve a whole proposal object into { applied, details, agent_adjusted }.
// proposals: { tp_percent, sl_percent, tripwire_percent, trail_step_percent }
// Only known fields with a parseable value are applied. `details` is the
// human-readable "clamped from X to Y" list for the truthful alert/log.
export function resolveEntryAdjust(proposals, cfgParams = {}) {
  const applied = {};
  const details = [];
  if (!proposals || typeof proposals !== 'object') {
    return { applied, details, agent_adjusted: false, clamped: false };
  }
  for (const field of ENTRY_ADJUST_FIELDS) {
    const res = clampEntryProposal(field, proposals[field], cfgParams);
    if (!res) continue;
    applied[field] = res.applied;
    if (res.clamped) {
      details.push(`${field} clamped from ${res.proposed} to ${res.applied} (bounds ${res.min}–${res.max})`);
    }
  }
  return {
    applied,
    details,
    agent_adjusted: Object.keys(applied).length > 0,
    clamped: details.length > 0,
  };
}

const entryAdjust = { ENTRY_ADJUST_FIELDS, ABS_MIN, ABS_MAX, clampEntryProposal, resolveEntryAdjust };
export default entryAdjust;
