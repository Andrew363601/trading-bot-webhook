-- Migration 050: PUSH AM32 — dual-head trainer (expectancy regression) +
-- dollar-quantified autopsies. ADDITIVE ONLY (no destructive changes).
--
-- Head 1 (existing): win-prob classifier per bucket, n>=20 — calibration card
--   row 1. Unchanged.
-- Head 2 (new): expectancy regression per bucket on signed pnl (real 1.0 /
--   shadow 0.5), features = entry geometry (sl_dist, tp_dist, tripwire,
--   trail_step, trail_activation) + regime/ATR context. n>=10, variance-
--   penalized via empirical-Bayes shrinkage (k=5) so it won't chase one lucky
--   bucket. Calibration card row 2: predicted vs realized $.
--
-- expected_pnl_model (calibration_models): Head 2 output — {p_win,
--   avg_win_usd, avg_loss_usd, expected_pnl_per_1k, ev_per_1k, n,
--   shrink_factor, pool_mean, top_profiles}. JSONB so the trainer's dict
--   shape can evolve without further migrations.
--
-- expected_cost_usd (hermes_core_memory): dollar-quantified autopsies —
--   every param_recommendation must cite a dollar figure; the trainer ranks
--   autopsy advice by claimed dollars and the next grade verifies the claim
--   (advice that claimed $12 and delivered $1 gets demoted). Lives alongside
--   param_field / param_direction (migration 048).

ALTER TABLE calibration_models
  ADD COLUMN IF NOT EXISTS expected_pnl_model jsonb;

ALTER TABLE hermes_core_memory
  ADD COLUMN IF NOT EXISTS expected_cost_usd numeric;
