-- 025-trade-memory-snapshots.sql
-- Persist a TRIMMED market-condition snapshot at entry AND at close for every
-- trade (paper + live), plus enrich hermes_core_memory with the trade metrics +
-- the close snapshot, so the agent can dissect/backtest/optimize WHY a trade
-- opened and closed.
--
-- Snapshots are intentionally small: we store only what we know for sure at the
-- moment (price, CVD, regime, ATR, OI, funding, volume nodes). No heavy raw
-- payloads.

-- ── trade_logs ────────────────────────────────────────────────────────────
ALTER TABLE trade_logs
  ADD COLUMN IF NOT EXISTS market_snapshot_at_entry jsonb,
  ADD COLUMN IF NOT EXISTS market_snapshot_at_close jsonb,
  ADD COLUMN IF NOT EXISTS regime_at_entry text,
  ADD COLUMN IF NOT EXISTS regime_at_close text;

COMMENT ON COLUMN trade_logs.market_snapshot_at_entry IS 'Trimmed market conditions captured when the position opened (price, cvd, regime, atr, oi, funding, volume nodes).';
COMMENT ON COLUMN trade_logs.market_snapshot_at_close IS 'Trimmed market conditions captured when the position closed — explains what caused the exit.';

-- ── hermes_core_memory ──────────────────────────────────────────────────────
-- Enrich the lesson store with the actual trade metrics + close snapshot so the
-- agent can correlate lessons with real outcomes (not just the textual lesson).
ALTER TABLE hermes_core_memory
  ADD COLUMN IF NOT EXISTS entry_price numeric,
  ADD COLUMN IF NOT EXISTS exit_price numeric,
  ADD COLUMN IF NOT EXISTS pnl numeric,
  ADD COLUMN IF NOT EXISTS execution_mode text,
  ADD COLUMN IF NOT EXISTS regime_at_close text,
  ADD COLUMN IF NOT EXISTS market_snapshot jsonb;

COMMENT ON COLUMN hermes_core_memory.market_snapshot IS 'Trimmed market conditions at the moment of close, fed into the autopsy.';
COMMENT ON COLUMN hermes_core_memory.execution_mode IS 'PAPER or LIVE — both are dissected for backtesting/optimization.';

-- Helpful indexes for the optimizer / backtester to scan closed trades fast.
CREATE INDEX IF NOT EXISTS idx_trade_logs_tenant_mode_exit
  ON trade_logs (tenant_id, execution_mode, exit_time);

CREATE INDEX IF NOT EXISTS idx_core_memory_tenant_asset
  ON hermes_core_memory (tenant_id, asset);
