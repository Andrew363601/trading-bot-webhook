-- 031-trade-pipeline-overhaul.sql
-- Phase 1: Link core memory to trades (bidirectional audit trail)
ALTER TABLE trade_logs
  ADD COLUMN IF NOT EXISTS influencing_memory_ids uuid[];

ALTER TABLE hermes_core_memory
  ADD COLUMN IF NOT EXISTS trade_log_id uuid REFERENCES trade_logs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hermes_core_memory_trade_log_id
  ON hermes_core_memory (trade_log_id);
