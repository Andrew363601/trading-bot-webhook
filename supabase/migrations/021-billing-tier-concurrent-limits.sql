-- 021-billing-tier-concurrent-limits.sql
-- Purpose: Enforce per-tier active-strategy quotas (SaaS plan limits).
--
-- Tiers (editable — change these defaults to retune any plan):
--   FREE_TRIAL    -> 1
--   RETAIL        -> 3
--   PRO           -> 10
--   INSTITUTIONAL -> 20
--   ADMIN         -> 9999 (effectively unlimited, used for internal/test accounts)
--
-- The actual runtime check lives in pages/api/{subscribe,deploy}-strategy.js;
-- this migration only seeds + maintains the per-tenant column so the API has a
-- value to read. The Stripe webhook is also updated to set this column whenever
-- a subscription is created/updated.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Make sure the column exists (it already does on most tenants, but in case
--    it was missed during earlier bootstrap, add it defensively).
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS max_concurrent_strategies integer;

COMMENT ON COLUMN public.tenants.max_concurrent_strategies IS
    'Per-tier ceiling on simultaneously-active strategies. Enforced by API endpoints. Editable per-tenant for overrides.';

-- ---------------------------------------------------------------------------
-- 2. Reusable helper that maps a billing_tier -> default quota.
--    Stored as a SQL function so the API and SQL paths agree on the numbers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.default_concurrent_strategies_for_tier(tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE upper(coalesce(tier, 'FREE_TRIAL'))
        WHEN 'FREE_TRIAL'     THEN 1
        WHEN 'RETAIL'         THEN 3
        WHEN 'PRO'            THEN 10
        WHEN 'INSTITUTIONAL'  THEN 20
        WHEN 'ADMIN'          THEN 9999
        ELSE 1
    END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill any tenant missing a quota using the helper above.
--    We DO NOT overwrite existing non-null values so manual per-tenant
--    overrides survive re-running the migration.
-- ---------------------------------------------------------------------------
UPDATE public.tenants
SET max_concurrent_strategies = public.default_concurrent_strategies_for_tier(billing_tier)
WHERE max_concurrent_strategies IS NULL;
