-- Migration 047: AK2 — admission control, two-ledger truth
-- ADDITIVE ONLY. Adds `admitted` to shadow_portfolio: true when NO other shadow row
-- for the same (tenant, asset) overlaps this row's [veto_time, sim_exit_time] window.
-- Config-$ cumulative series (pages/api/performance/timeline.js) uses ADMITTED rows
-- only; ledger + SAVED/MISSED % stats + decision counts keep ALL rows.

ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS admitted boolean;

-- Admission check index: worker queries other rows for the same (tenant, asset)
-- whose window overlaps the candidate's [veto_time, sim_exit_time].
CREATE INDEX IF NOT EXISTS idx_shadow_admission_lookup
  ON shadow_portfolio (tenant_id, asset, veto_time)
  WHERE sim_exit_time IS NOT NULL;
