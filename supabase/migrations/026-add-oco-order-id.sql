-- 026-add-oco-order-id.sql
-- Tracks the Coinbase order_id of the active OCO bracket for each trade_log.
-- Enables the watchdog to directly verify bracket status instead of pattern-matching,
-- and prevents false fills from unrelated trades being matched.

ALTER TABLE trade_logs
ADD COLUMN IF NOT EXISTS oco_order_id TEXT;

COMMENT ON COLUMN trade_logs.oco_order_id IS 'Coinbase order_id of the currently active TP/SL OCO bracket. Set on bracket deployment, cleared on close/cancel.';
