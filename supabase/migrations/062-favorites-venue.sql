-- Migration 062: PUSH AM63 (Push 5) — per-venue favorites.
-- ADDITIVE / IDEMPOTENT. No destructive operations. No uuid-ossp dependency.
--
-- The dashboard asset matrix is now venue-aware (COINBASE | Kraken US (Bitnomial) |
-- Kraken Futures). A favorite must therefore be scoped to the venue it was starred
-- on, or a Coinbase star would leak into the Kraken Futures matrix (and vice versa).
--
-- This is a FRESH column, so default + NOT NULL can be applied IMMEDIATELY — there
-- is no one-way-door risk (contrast migration 061, whose normalize step was a
-- one-way door because it rewrote an EXISTING column). Every existing favorite row
-- is a Coinbase star (the only venue that ever had a matrix), so the default is
-- correct for all history.
--
-- Safe to paste more than once. Operator pastes in the Supabase SQL editor
-- (no CI migration runner).

-- ── (1) Add the venue column (fresh → default + NOT NULL immediately) ───────
alter table favorite_assets
  add column if not exists venue text not null default 'coinbase';

-- ── (2) Idempotent normalize: any crafted/NULL value → the canonical lowercase ──
-- (No such rows exist today; this is a belt-and-braces guard so the column can
--  never hold a non-canonical shape. It does NOT rewrite a legitimate venue.)
update favorite_assets
   set venue = lower(venue)
 where venue is not null and venue <> lower(venue);

-- ── (3) Uniqueness key becomes (tenant_id, asset, venue) ────────────────────
-- A tenant may now favorite the SAME asset id on two venues (e.g. BTC-PERP-INTX on
-- Coinbase and BTC-PERP-KRF on Kraken Futures are distinct ids, but a shared base
-- could collide across venues in future). Scope the uniqueness to the venue.
create unique index if not exists uq_favorite_assets_tenant_asset_venue
  on favorite_assets (tenant_id, asset, venue);

comment on column favorite_assets.venue is
  'AM63 (Push 5): the venue this favorite was starred on. Canonical lowercase; default ''coinbase''. Favorites are scoped per venue in the dashboard matrix.';
