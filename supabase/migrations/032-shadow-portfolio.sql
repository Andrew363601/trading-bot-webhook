-- 032-shadow-portfolio.sql
-- Shadow Portfolio: Labels every VETO with its real-world outcome so the
-- Confluence Oracle can learn from decisions to NOT trade.
--
-- VALIDATED against actual codebase (watchdog.js, execute-trade-mcp.js patterns)

DROP TABLE IF EXISTS shadow_portfolio CASCADE;

CREATE TABLE IF NOT EXISTS shadow_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  -- ⚠ scan_results.id is INTEGER (confirmed from live DB), not UUID
  scan_id INTEGER REFERENCES scan_results(id) ON DELETE SET NULL,
  asset TEXT NOT NULL,
  signal_direction TEXT NOT NULL,             -- 'BUY' or 'SELL'
  conviction_score INTEGER,
  veto_price DECIMAL,
  veto_time TIMESTAMPTZ NOT NULL,
  veto_regime TEXT,

  -- The actual trade that followed (if one exists within 24h)
  trade_log_id INTEGER REFERENCES trade_logs(id) ON DELETE SET NULL,
  trade_side TEXT,
  trade_pnl DECIMAL,

  -- Verdict
  verdict TEXT NOT NULL,                      -- 'SAVED' | 'MISSED' | 'NEUTRAL'
  saved_amount DECIMAL,
  missed_amount DECIMAL,
  actual_move_pct DECIMAL,
  duration_minutes INTEGER,

  -- Counterfactual (no trade followed, uses 6h candle data)
  counterfactual_low DECIMAL,
  counterfactual_high DECIMAL,
  counterfactual_direction TEXT,              -- 'WENT_AGAINST' | 'WENT_WITH' | 'FLAT'

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_tenant
  ON shadow_portfolio (tenant_id);
CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_verdict
  ON shadow_portfolio (verdict);
CREATE INDEX IF NOT EXISTS idx_shadow_portfolio_asset_time
  ON shadow_portfolio (asset, created_at);

-- Row-level security: same isolation pattern as trade_logs
ALTER TABLE shadow_portfolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shadow_portfolio_tenant_isolation" ON shadow_portfolio
  USING (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() LIMIT 1));

