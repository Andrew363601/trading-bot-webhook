-- Migration 039: Thread macro_tf and trigger_tf into trade_logs
-- Allows calibration models to key by timeframe pair (macro_tf, trigger_tf).

ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS macro_tf TEXT;
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS trigger_tf TEXT;
