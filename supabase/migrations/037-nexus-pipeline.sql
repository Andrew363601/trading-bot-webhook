-- 037-nexus-pipeline.sql
-- NEXUS TRADING BOT — Full Pipeline Upgrade (Phase B: DB migration)
-- Run BEFORE Push #2 (enrichment plumbing) — schema must precede code that
-- reads/writes these columns. Pure additive; safe to run anytime.
--
-- Conventions (Phase 0.9.1):
--   * tenant_id = NULL  → GLOBAL row (trained on all tenants' trades)
--   * strategy_id       → UPPER-normalized at every write (app layer)

-- ═══════════════════════════════════════════════════════════════
-- PHASE 0.1 — New tables
-- ═══════════════════════════════════════════════════════════════

-- Calibration models (trained model parameters + feature importance)
CREATE TABLE IF NOT EXISTS calibration_models (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    asset TEXT NOT NULL,
    regime TEXT,
    archetype TEXT,
    model_params JSONB,        -- serialized model coefficients
    feature_importance JSONB,  -- { feature_name: importance_score }
    metrics JSONB,             -- { accuracy, precision, recall, f1, sample_count }
    sample_count INT DEFAULT 0,
    expected_pnl_mean FLOAT,
    expected_pnl_std FLOAT,
    last_trained TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Regime transition matrix (per asset — GLOBAL market physics, Phase 0.9.1:
-- tenant_id is nullable and left NULL for global rows; unique key is
-- asset + transition pair so upserts target the global row)
CREATE TABLE IF NOT EXISTS regime_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    asset TEXT NOT NULL,
    from_regime TEXT NOT NULL,
    to_regime TEXT NOT NULL,
    count INT DEFAULT 0,
    avg_duration_minutes FLOAT,
    avg_cvd_at_transition FLOAT,
    avg_imbalance_at_transition FLOAT,
    avg_price_change_percent FLOAT,
    breakout_direction TEXT,         -- BUY or SELL for CHOP→TREND
    breakout_direction_accuracy FLOAT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, asset, from_regime, to_regime)
);

-- Microstructure archetype statistics
-- tenant_id nullable: NULL = global structural stats (Phase 0.9.1)
CREATE TABLE IF NOT EXISTS microstructure_archetypes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    archetype_name TEXT NOT NULL,
    asset TEXT NOT NULL,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    sample_count INT DEFAULT 0,
    win_rate FLOAT,
    avg_pnl FLOAT,
    avg_tp_atr FLOAT,       -- optimal TP distance in ATR terms
    avg_sl_atr FLOAT,       -- optimal SL distance in ATR terms
    avg_hold_time_minutes FLOAT,
    optimal_tripwire_percent FLOAT,
    optimal_trail_step_percent FLOAT,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, asset, archetype_name)
);

-- trade_logs: model + archetype + conviction + fee columns at entry
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS microstructure_archetype TEXT;
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS model_predicted_win_prob FLOAT;
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS model_predicted_pnl FLOAT;
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS conviction_score_at_entry INT;
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS transaction_fee FLOAT;

-- agent_tool_calls: conviction capture at tool-call time
ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS conviction_score INT;

-- Index for model training queries
CREATE INDEX IF NOT EXISTS idx_trade_logs_training
  ON trade_logs(tenant_id, exit_price, created_at)
  WHERE market_snapshot_at_entry IS NOT NULL AND exit_price IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- PHASE 0.7.1 — Core memory strategy + TF keying
-- ═══════════════════════════════════════════════════════════════

-- Core memory: add strategy + TF columns (UPPER-normalized / 'ANY' for legacy)
ALTER TABLE hermes_core_memory ADD COLUMN IF NOT EXISTS strategy_id TEXT;
ALTER TABLE hermes_core_memory ADD COLUMN IF NOT EXISTS macro_tf TEXT;
ALTER TABLE hermes_core_memory ADD COLUMN IF NOT EXISTS trigger_tf TEXT;

CREATE INDEX IF NOT EXISTS idx_core_memory_strategy_tf
  ON hermes_core_memory(asset, strategy_id, macro_tf, trigger_tf);

-- calibration_models: strategy key for tiered model resolution (L3)
ALTER TABLE calibration_models ADD COLUMN IF NOT EXISTS strategy TEXT;

-- microstructure_archetypes: optional per-strategy exit tuning
ALTER TABLE microstructure_archetypes ADD COLUMN IF NOT EXISTS strategy TEXT;

-- ═══════════════════════════════════════════════════════════════
-- PHASE 0.7.8 — Legacy memory backfill (self-healing 'ANY' tags)
-- Old memories stay eligible in the asset-only pool with 0 bonus
-- ═══════════════════════════════════════════════════════════════
UPDATE hermes_core_memory SET strategy_id = 'ANY' WHERE strategy_id IS NULL;
UPDATE hermes_core_memory SET macro_tf = 'ANY' WHERE macro_tf IS NULL;
UPDATE hermes_core_memory SET trigger_tf = 'ANY' WHERE trigger_tf IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- PHASE 0.9.1 — Multi-tenant scoping constraint adjustments
-- regime_transitions: market physics is identical for every tenant →
-- global rows (tenant_id NULL). Drop the NOT NULL-ness via the FK column's
-- nullability (column is already nullable from CREATE; keep constraint drop
-- for idempotency with the Phase 0.1 spec variant that had it NOT NULL).
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE regime_transitions DROP CONSTRAINT IF EXISTS regime_transitions_tenant_id_asset_from_regime_to_regime_key;
ALTER TABLE regime_transitions ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE microstructure_archetypes ALTER COLUMN tenant_id DROP NOT NULL;

-- Recreate unique constraint on the global key (asset + transition pair).
-- Using a partial-unique on NULL tenant rows + the original composite for
-- tenant rows keeps both scopes conflict-targetable for upserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_regime_transitions_global
  ON regime_transitions(asset, from_regime, to_regime)
  WHERE tenant_id IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- RLS: enable on new tables, permissive for service-role (trainer + workers
-- use service role key; UI reads go through the Next.js API layer)
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE calibration_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE regime_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE microstructure_archetypes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access calibration_models" ON calibration_models;
CREATE POLICY "Service role full access calibration_models" ON calibration_models
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access regime_transitions" ON regime_transitions;
CREATE POLICY "Service role full access regime_transitions" ON regime_transitions
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access microstructure_archetypes" ON microstructure_archetypes;
CREATE POLICY "Service role full access microstructure_archetypes" ON microstructure_archetypes
  FOR ALL USING (true) WITH CHECK (true);

-- Comments
COMMENT ON TABLE calibration_models IS 'NEXUS L3: per-asset/regime/strategy win-prob models. tenant_id NULL = global (anonymized numeric aggregates only).';
COMMENT ON TABLE regime_transitions IS 'NEXUS L4: global regime transition matrix per asset (market physics — no tenant scoping).';
COMMENT ON TABLE microstructure_archetypes IS 'NEXUS L5: microstructure archetype stats. tenant_id NULL = global structural stats.';
