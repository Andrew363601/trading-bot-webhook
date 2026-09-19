-- Migration 046: AG1/AG3 — strategy-true shadow simulation + autopsy feed
-- ADDITIVE ONLY. Adds sim_* columns to shadow_portfolio (strategy-true sim engine,
-- workers/shadow-portfolio.js Path B) and autopsied_at for the 6h shadow autopsy feed.
-- Old rows keep sim_* NULL (implicit version marker); legacy amounts untouched.

ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_exit_price numeric;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_exit_time timestamptz;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_exit_reason text;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_pnl_pts numeric;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_pnl_usd numeric;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_bars int;
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS sim_params jsonb;

-- AG3: 6h shadow autopsy feed batch marker
ALTER TABLE shadow_portfolio ADD COLUMN IF NOT EXISTS autopsied_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_shadow_autopsy_pending
  ON shadow_portfolio (autopsied_at)
  WHERE autopsied_at IS NULL;
