-- Migration 043: Discord links (Push I — Phase 3 core)
-- One row per tenant: Discord identity captured during the challenge popup auto-join.
-- challenge_entries.discord_linked already exists (041) — no column add needed here.

CREATE TABLE IF NOT EXISTS discord_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL UNIQUE,
  discord_username TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE discord_links ENABLE ROW LEVEL SECURITY;
