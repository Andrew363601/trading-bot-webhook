-- supabase/migrations/005-backfill-tenant-ids.sql
-- Backfill existing trade_logs with tenant_id from users table

BEGIN;

-- Step 1: Create temporary column if needed (in case tenant_id doesn't exist yet)
ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Step 2: Backfill trade_logs with tenant_id
-- For each trade, find its associated tenant via the auth_user_id or other identifier
-- Assuming there's a auth_user_id or created_by field in trade_logs
UPDATE trade_logs tl
SET tenant_id = (
  SELECT tu.tenant_id
  FROM tenant_users tu
  WHERE tu.auth_user_id = (
    SELECT id FROM auth.users 
    LIMIT 1  -- You may need to adjust this based on your actual user association
  )
  LIMIT 1
)
WHERE tl.tenant_id IS NULL;

-- Alternative if trade_logs has created_by field:
-- UPDATE trade_logs tl
-- SET tenant_id = (
--   SELECT tu.tenant_id
--   FROM tenant_users tu
--   WHERE tu.auth_user_id = tl.created_by
--   LIMIT 1
-- )
-- WHERE tl.tenant_id IS NULL;

-- Step 3: For any remaining NULL values, assign to first active tenant
UPDATE trade_logs tl
SET tenant_id = (
  SELECT id FROM tenants 
  ORDER BY created_at ASC 
  LIMIT 1
)
WHERE tl.tenant_id IS NULL;

-- Step 4: Add NOT NULL constraint
ALTER TABLE trade_logs ALTER COLUMN tenant_id SET NOT NULL;

-- Step 5: Add index for tenant_id
CREATE INDEX IF NOT EXISTS idx_trade_logs_tenant ON trade_logs(tenant_id);

-- Step 6: Verify results
SELECT 
  tenant_id,
  COUNT(*) as trade_count
FROM trade_logs
GROUP BY tenant_id
ORDER BY trade_count DESC;

COMMIT;
