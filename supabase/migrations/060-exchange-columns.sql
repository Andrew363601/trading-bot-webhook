-- Migration 060: PUSH AM63 (Push 2) — per-row venue addressing.
-- ADDITIVE ONLY (no destructive changes). No uuid-ossp dependency.
--
-- Adds an `exchange` column to strategy_config and trade_logs, defaulting to
-- 'coinbase' — the only venue that has ever existed in this system. This makes a
-- venue ADDRESSABLE per config and per trade WITHOUT changing any behavior: every
-- existing row and every existing call site resolves to Coinbase.
--
-- The 057 lesson applies: code deployed before its column = inserts fail (silently
-- on LIVE, loudly on PAPER). PASTE THIS IN THE SUPABASE SQL EDITOR *BEFORE* the
-- AM63 Push 2 deploy. The execute-trade-mcp safety nets tolerate its absence (the
-- trade row still survives), but the loud [AM63] log line fires if ordering slips.
--
-- NOTE: no backfill is needed or wanted. Every existing row defaults to
-- 'coinbase', which is CORRECT — Coinbase is the only venue that has ever traded
-- here. An unknown venue (e.g. a hand-edited 'kraken' row) is refused LOUD downstream
-- by lib/exchange-router.js rather than silently coerced to Coinbase.

-- ── (1) strategy_config.exchange ────────────────────────────────────────────
alter table strategy_config
  add column if not exists exchange text not null default 'coinbase';

comment on column strategy_config.exchange is
  'AM63: venue this strategy config trades on. Default ''coinbase'' (the only supported venue until Push 4).';

-- ── (2) trade_logs.exchange ─────────────────────────────────────────────────
alter table trade_logs
  add column if not exists exchange text not null default 'coinbase';

comment on column trade_logs.exchange is
  'AM63: venue this trade routed to, stamped at insert from the strategy config (default ''coinbase''). Legacy rows default to coinbase — the only venue that has ever existed.';

create index if not exists idx_trade_logs_tenant_exchange
  on trade_logs (tenant_id, exchange);
