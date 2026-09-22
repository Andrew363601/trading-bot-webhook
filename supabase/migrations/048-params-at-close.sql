-- Migration 048: PUSH AM7 — parameters at close (config-as-truth + agent diff)
-- ADDITIVE ONLY.
--   trade_logs.params_context / shadow_portfolio.params_context:
--     { config_id, agent_adjusted, tp_price, sl_price, tripwire, trail_step }
--     Stamped at close. strategy_config is the single source of truth — no full
--     snapshots; the config was current at close by definition.
--   hermes_core_memory.param_field / param_direction:
--     Structured param_recommendation from /api/autopsy (field + direction).
--   calibration_models.suggested_params:
--     Layer 2 trainer output — top params profile per bucket
--     (win-rate / E[pnl] / n / human-readable summary).

ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS params_context jsonb;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS params_context jsonb;
ALTER TABLE hermes_core_memory ADD COLUMN IF NOT EXISTS param_field text;
ALTER TABLE hermes_core_memory ADD COLUMN IF NOT EXISTS param_direction text;
ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS suggested_params jsonb;
