-- Migration 064: AM72 — canonical parameters schema scrub (one-time).
-- ADDITIVE / IDEMPOTENT. No destructive operations. No uuid-ossp dependency.
--
-- AM72 collapses strategy_config.parameters to the CANONICAL end-user schema:
--   qty, leverage, macro_tf, trigger_tf, tp_percent, sl_percent,
--   tripwire_percent, trail_step_percent, veto_cooldown_minutes
--
-- This migration removes the LEGACY / duplicate-truth keys that older write paths
-- (and two client call sites) leaked into the blob:
--   quantity          — UI label only; no loader ever read it
--   stop_loss_pct     — UI label only; canonical is sl_percent
--   take_profit_pct   — UI label only; canonical is tp_percent
--   market_type       — now DERIVED from the venue at the trade stamp
--                       (krakenspot → SPOT, else FUTURES); the blob key is gone
--   execution_mode    — the strategy_config.execution_mode COLUMN is the ONLY mode
--                       source; the blob copy is the split-brain this push kills
--
-- SCOPE: strategy_config ONLY. trade_logs.params_context snapshots are HISTORICAL
-- TRUTH (what was actually applied at entry/close) and are deliberately NOT touched.
--
-- IDEMPOTENT: `jsonb - 'key'` is a no-op when the key is absent, and the WHERE
-- clause (`?|`) means a re-run after the first scrub touches ZERO rows. Safe to
-- paste more than once.
--
-- Operator pastes in the Supabase SQL editor (no CI migration runner) BEFORE
-- deploying AM72. Live-schema probe first: confirm strategy_config.parameters is
-- jsonb and the legacy keys exist before/after.

-- ── (1) Scrub the legacy keys from every strategy_config.parameters row ──────
-- Only rows that actually carry one of the legacy keys are rewritten (idempotent).
update strategy_config
set parameters = parameters
      - 'quantity'
      - 'stop_loss_pct'
      - 'take_profit_pct'
      - 'market_type'
      - 'execution_mode'
where parameters ?| array['quantity', 'stop_loss_pct', 'take_profit_pct', 'market_type', 'execution_mode'];

-- ── (2) Guard: parameters must never be NULL after the scrub ─────────────────
-- A row whose blob was ONLY legacy keys would become '{}' (not NULL) — jsonb
-- minus always returns an object. This is a defensive no-op for the normal case.
update strategy_config
set parameters = '{}'::jsonb
where parameters is null;

comment on column strategy_config.parameters is
  'AM72 canonical schema: qty, leverage, macro_tf, trigger_tf, tp_percent, sl_percent, tripwire_percent, trail_step_percent, veto_cooldown_minutes. Legacy keys (quantity, stop_loss_pct, take_profit_pct, market_type, execution_mode) are scrubbed by migration 064 and stripped on every write path. execution_mode lives ONLY in the strategy_config.execution_mode column.';
