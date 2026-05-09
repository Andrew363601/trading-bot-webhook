-- supabase/migrations/006-favorite-assets.sql
-- Create favorite_assets table for storing user's favorite trading pairs

CREATE TABLE IF NOT EXISTS favorite_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, asset)
);

-- Enable RLS
ALTER TABLE favorite_assets ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their tenant's favorites
CREATE POLICY favorite_assets_tenant_isolation ON favorite_assets
  USING (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() LIMIT 1));

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_favorite_assets_tenant ON favorite_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_favorite_assets_asset ON favorite_assets(tenant_id, asset);
