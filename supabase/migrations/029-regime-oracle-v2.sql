-- 029-regime-oracle-v2.sql
-- Regime Oracle v2 — Backfill corrupt regime data
--
-- NOTE: thesis_accurate / thesis_summary columns already exist via
-- 027-core-memory-thesis-accuracy.sql — no column adds needed here.
--
-- The regime source of truth is the mathematical classifier in
-- fetchMicrostructure() (workers/sniper.js). Historically, macro_regime_oracle
-- was polluted with status strings ("EVALUATING", "AGENT VETO", "POSITION CLOSED",
-- "ORDER CANCELED", "HANDED TO AGENT") instead of real regimes
-- (TREND / CHOP / ACCUMULATION / DISTRIBUTION).
--
-- This migration recovers the real regime from the market_snapshot JSON that
-- was persisted alongside each close, where available.

-- Phase 1: Backfill regime_at_close in hermes_core_memory from market_snapshot JSON
-- Covers all known corruption patterns
UPDATE hermes_core_memory
SET regime_at_close = market_snapshot->>'regime'
WHERE (regime_at_close IS NULL OR
       regime_at_close = 'HANDED TO AGENT' OR
       regime_at_close = 'EVALUATING' OR
       regime_at_close LIKE 'AGENT%' OR
       regime_at_close LIKE 'POSITION%')
  AND market_snapshot IS NOT NULL
  AND market_snapshot->>'regime' IS NOT NULL;

-- Phase 2: Backfill trade_logs the same way
UPDATE trade_logs
SET regime_at_close = market_snapshot_at_close->>'regime'
WHERE (regime_at_close IS NULL OR
       regime_at_close = 'HANDED TO AGENT' OR
       regime_at_close = 'EVALUATING' OR
       regime_at_close LIKE 'AGENT%' OR
       regime_at_close LIKE 'POSITION%')
  AND market_snapshot_at_close IS NOT NULL
  AND market_snapshot_at_close->>'regime' IS NOT NULL;