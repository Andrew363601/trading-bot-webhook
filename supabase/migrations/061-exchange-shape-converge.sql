-- Migration 061: PUSH AM63 (Push 3) — exchange column shape convergence.
-- ADDITIVE / IDEMPOTENT. No destructive operations. No uuid-ossp dependency.
--
-- strategy_config.exchange ALREADY EXISTS — it pre-dates migration 060, which is
-- precisely why 060's `add column if not exists exchange ...` no-opped on it.
-- 060 added the column to trade_logs + the tenant index; it did NOT converge the
-- shape of the pre-existing strategy_config.exchange column. That is this
-- migration's single job.
--
-- CONVERGENCE (not a behavior change):
--   1. Normalize any non-canonical casing to the canonical lowercase form
--      ('COINBASE' -> 'coinbase'). IDEMPOTENT: a re-run after normalization
--      touches zero rows.
--   2. Pin the column DEFAULT to 'coinbase' — the only venue that has ever traded.
--   3. Pin NOT NULL so a venue-less config is impossible at the DB layer.
--
-- Safe to paste more than once. Operator pastes in the Supabase SQL editor
-- (no CI migration runner).
--
-- WHY NOT READ-TIME LOWERCASING: normalizing only at read time leaves every future
-- environment free to persist a non-canonical shape. The column itself is the
-- contract, so the convergence lives here in SQL.
--
-- NOTE — deliberate asymmetry: the credential vault (api_keys_vault.exchange)
-- keeps its OWN uppercase convention ('COINBASE' legacy rows; 'KRAKEN'), while the
-- ROUTING columns (strategy_config.exchange / trade_logs.exchange) stay lowercase
-- canonical. Push 4's adapter reads the vault with 'KRAKEN'. Do NOT "unify" these.

-- ── (1) Normalize casing to canonical lowercase (idempotent) ────────────────
update strategy_config
   set exchange = lower(exchange)
 where exchange is not null
   and exchange <> lower(exchange);

-- ── (2) Pin the DEFAULT ─────────────────────────────────────────────────────
alter table strategy_config
  alter column exchange set default 'coinbase';

-- ── (3) Pin NOT NULL (fill any NULLs first so the constraint can apply) ─────
update strategy_config
   set exchange = 'coinbase'
 where exchange is null;

alter table strategy_config
  alter column exchange set not null;

comment on column strategy_config.exchange is
  'AM63: venue this strategy config trades on. Canonical lowercase; default ''coinbase'' (the only supported venue until Push 4).';
