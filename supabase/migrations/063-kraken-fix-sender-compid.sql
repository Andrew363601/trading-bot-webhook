-- Migration 063: AM65 — Unified FIX lane — the per-tenant FIX SenderCompID.
-- ADDITIVE / IDEMPOTENT. No destructive operations. No uuid-ossp dependency.
--
-- Kraken assigns the SenderCompID at FIX onboarding (derivatives sessions carry
-- a DRV suffix). The FIX lane resolves it: vault fix_sender_comp_id → env
-- KRAKEN_FIX_SENDER_COMPID → LOUD refusal (never silent, never a Coinbase
-- substitution). The FIX key/secret themselves ride the EXISTING
-- api_keys_vault KRAKENFUTURES row (a FIX key is created as a Spot key even
-- when used for derivatives — docs verbatim), so ONLY this column is new.
--
-- Safe to paste more than once. Operator pastes in the Supabase SQL editor
-- (no CI migration runner) BEFORE deploying Commit B.
--
-- RLS: api_keys_vault policies already scope the whole row to the tenant —
-- the new column inherits them; no policy changes.

alter table api_keys_vault add column if not exists fix_sender_comp_id text;

comment on column api_keys_vault.fix_sender_comp_id is
  'AM65: Kraken-assigned FIX SenderCompID (DRV suffix for derivatives). Resolved by the Unified FIX lane: vault → env KRAKEN_FIX_SENDER_COMPID → loud refusal.';
