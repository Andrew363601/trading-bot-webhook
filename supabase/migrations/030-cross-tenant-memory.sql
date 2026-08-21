-- 030-cross-tenant-memory.sql
-- Cross-Tenant Reflection DB: adds privacy opt-out for memory sharing.
-- Default share = true: all tenants participate in the unified pool.
-- Setting to false: tenant only sees their own memories.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS share_memory boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_tenant_settings_share_memory
  ON tenant_settings (tenant_id, share_memory);

COMMENT ON COLUMN tenant_settings.share_memory IS
  'Controls cross-tenant memory pool participation. Default true (shared). When false, the tenant only sees their own core memory lessons.';