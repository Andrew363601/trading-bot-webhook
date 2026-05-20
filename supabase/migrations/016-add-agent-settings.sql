-- Agent Settings: Active Trade Management & Cost Awareness
-- Adds configurable columns to tenant_settings for agent behavior tuning

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS agent_open_trade_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_open_trade_reverse BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_open_trade_close BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_open_trade_adjust_tp_sl BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_open_trade_tripwire_adjust BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_taker_fee_rate NUMERIC(8,6) DEFAULT 0.0008;
