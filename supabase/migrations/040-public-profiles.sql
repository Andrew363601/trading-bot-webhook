-- Migration 040: Public profiles for opt-in rolling leaderboard

CREATE TABLE IF NOT EXISTS public_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public_profiles ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS "Service role full access public_profiles" ON public_profiles;
CREATE POLICY "Service role full access public_profiles" ON public_profiles
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Authenticated tenants can select, insert, or update their own profile
DROP POLICY IF EXISTS "Tenant select public_profiles" ON public_profiles;
CREATE POLICY "Tenant select public_profiles" ON public_profiles
  FOR SELECT
  USING (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Tenant insert/update public_profiles" ON public_profiles;
CREATE POLICY "Tenant insert/update public_profiles" ON public_profiles
  FOR ALL
  USING (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()
  ));
