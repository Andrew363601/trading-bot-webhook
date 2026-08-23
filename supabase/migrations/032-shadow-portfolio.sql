-- 032-shadow-portfolio.sql
-- Shadow Portfolio: Labels every VETO with its real-world outcome so the
-- Confluence Oracle can learn from decisions to NOT trade.

CREATE TABLE IF NOT EXISTS shadow_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  scan_id BIGINT REFERENCES scan_results(id) ON DELETE SET NULL,
  asset TEXT NOT NULL,
  signal_direction TEXT NOT NULL,       -- 'BUY' or 'SELL'
  conviction_score INTEGER,             -- from AI decision (0-100)
  veto_price DECIMAL,                   -- price at veto time
  veto_time TIMESTAMPTZ NOT NULL,       -- when veto happened
  veto_regime TEXT,                     -- macro regime at veto time

  -- Actual trade that followed (if one exists)
  trade_log_id BIGINT REFERENCES trade_logs(id) ON DELETE SET NULL,

  -- Calculated verdict
  verdict TEXT NOT NULL,                -- 'SAVED' | 'MISSED' | 'NEUTRAL'
  saved_amount DECIMAL,                 -- how much the veto saved (positive = prevented loss)
  missed_amount DECIMAL,                -- how much was missed (positive = missed profit)
  actual_move_pct DECIMAL,              -- % price moved from veto to trade entry
  entry_to_exit_pnl DECIMAL,            -- the actual trade's PnL
  duration_minutes INTEGER,             -- time between veto and trade entry

  -- For vetos with no subsequent trade (counterfactual)
  counterfactual_low DECIMAL,
  counterfactual_high DECIMAL,
  counterfactual_direction TEXT,        -- 'WENT_AGAINST' | 'WENT_WITH' | 'FLAT'

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_tenant
  ON shadow_portfolio (tenant_id);
CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_verdict
  ON shadow_portfolio (verdict);
CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_asset_time
  ON shadow_portfolio (asset, created_at);

-- Row-level security: same tenant isolation as trade_logs
ALTER TABLE shadow_portfolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shadow_portfolio_tenant_isolation" ON shadow_portfolio
  USING (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() LIMIT 1));
