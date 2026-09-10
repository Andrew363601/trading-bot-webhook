-- Migration 041: 100K Simulation Challenge entries
-- One entry per tenant, 30-day fixed window (2026-09-11 → 2026-10-11).

CREATE TABLE IF NOT EXISTS challenge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,                       -- copied from leaderboard profile (must be opted in)
  start_equity NUMERIC NOT NULL DEFAULT 100000,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ NOT NULL,         -- challenge start (2026-09-11 00:00 UTC when seeded via API)
  window_end TIMESTAMPTZ NOT NULL,           -- window_start + 30 days
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','disqualified')),
  discord_linked BOOLEAN NOT NULL DEFAULT false,  -- phase 3 flips this
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_challenge_entries_tenant ON challenge_entries (tenant_id);

ALTER TABLE challenge_entries ENABLE ROW LEVEL SECURITY;

-- RLS: insert/read own rows via authenticated policy; all service-role access through API routes only.
DROP POLICY IF EXISTS "Tenant select own challenge entry" ON challenge_entries;
CREATE POLICY "Tenant select own challenge entry" ON challenge_entries
  FOR SELECT
  USING (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Tenant insert own challenge entry" ON challenge_entries;
CREATE POLICY "Tenant insert own challenge entry" ON challenge_entries
  FOR INSERT
  WITH CHECK (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()
  ));
