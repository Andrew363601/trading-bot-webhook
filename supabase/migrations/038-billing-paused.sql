-- Migration: 038-billing-paused.sql
-- Description: Add billing_paused column to strategy_config to track auto-deactivations on billing lockdown.

ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS billing_paused BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_strategy_config_billing_paused
  ON strategy_config (tenant_id) WHERE billing_paused = TRUE;
