-- 015-add-onboarding-columns.sql
-- Adds risk assessment, quick start tracking, and daily ROI target columns.

-- ============================================================
-- 1. ADD RISK ASSESSMENT COLUMNS (idempotent)
-- ============================================================
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS account_balance_usd NUMERIC DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS max_position_size_usd NUMERIC DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS max_leverage NUMERIC DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS risk_per_trade_percent NUMERIC DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS max_daily_loss_usd NUMERIC DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS max_concurrent_trades INTEGER DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS allowed_assets TEXT[] DEFAULT NULL;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS risk_assessment_complete BOOLEAN DEFAULT false;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS risk_assessment_data JSONB DEFAULT NULL;

-- ============================================================
-- 2. ADD DAILY ROI TARGET COLUMN (idempotent)
-- ============================================================
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS daily_roi_target_usd NUMERIC DEFAULT 1000;

-- ============================================================
-- 3. ADD QUICK START / COINBASE TRACKING COLUMNS (idempotent)
-- ============================================================
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS coinbase_account_created BOOLEAN DEFAULT false;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS quick_start_dismissed BOOLEAN DEFAULT false;
ALTER TABLE public.tenant_settings ADD COLUMN IF NOT EXISTS quick_start_step INTEGER DEFAULT 0;

-- ============================================================
-- 4. BACKFILL: Set daily_roi_target_usd = 1000 for any existing
--    rows where it's still NULL (newly added column).
-- ============================================================
UPDATE public.tenant_settings
SET daily_roi_target_usd = 1000
WHERE daily_roi_target_usd IS NULL;

-- ============================================================
-- 5. BACKFILL: If account_balance_usd is NULL but the tenant
--    has paper trade logs, set a default of 5000.
-- ============================================================
UPDATE public.tenant_settings ts
SET account_balance_usd = 5000
WHERE ts.account_balance_usd IS NULL
AND EXISTS (
    SELECT 1 FROM public.trade_logs tl
    WHERE tl.tenant_id = ts.tenant_id
    AND tl.execution_mode = 'PAPER'
    LIMIT 1
);

-- ============================================================
-- 6. VERIFICATION
-- ============================================================
DO $$
DECLARE
    col_count int;
    backfilled_targets int;
    backfilled_balances int;
BEGIN
    SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
    WHERE table_name = 'tenant_settings' AND table_schema = 'public';
    
    SELECT COUNT(*) INTO backfilled_targets
    FROM public.tenant_settings
    WHERE daily_roi_target_usd = 1000;
    
    RAISE LOG 'tenant_settings now has % columns. % rows have daily_roi_target_usd set.', col_count, backfilled_targets;
END
$$;
