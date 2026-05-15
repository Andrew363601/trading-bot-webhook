-- 014-add-is-active-to-tenants.sql
-- Adds the missing `is_active` column to the `tenants` table, which is required
-- by the multi-tenant worker manager (tenant-worker-manager.js) to query active tenants.
-- Backfills existing rows to active (true) by default.

-- ============================================================
-- 1. ADD is_active COLUMN (idempotent)
-- ============================================================
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- ============================================================
-- 2. BACKFILL any rows where is_active might be NULL
-- ============================================================
UPDATE public.tenants SET is_active = true WHERE is_active IS NULL;

-- ============================================================
-- 3. CREATE INDEX for performance on the worker query
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tenants_is_active ON public.tenants(is_active);

-- ============================================================
-- 4. VERIFICATION (runs as a notice)
-- ============================================================
DO $$
DECLARE
    total_tenants int;
    active_tenants int;
BEGIN
    SELECT COUNT(*) INTO total_tenants FROM public.tenants;
    SELECT COUNT(*) INTO active_tenants FROM public.tenants WHERE is_active = true;
    RAISE LOG 'is_active column added. Total tenants: %, Active tenants: %', total_tenants, active_tenants;
END
$$;
