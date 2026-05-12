-- 010-add-missing-tenant-ids.sql
-- This migration script adds the 'tenant_id' column to tables that were
-- previously missing it, ensuring all tenant-scoped data can be properly isolated
-- by Row Level Security policies.

-- IMPORTANT: Ensure this script is run *before* applying RLS policies that depend on 'tenant_id'
-- on these specific tables.

DO $$
BEGIN
    -- Add tenant_id to favorite_assets if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='favorite_assets' AND column_name='tenant_id') THEN
        ALTER TABLE favorite_assets ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_favorite_assets_tenant_id ON favorite_assets(tenant_id);
    END IF;

    -- Add tenant_id to backtest_results if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='backtest_results' AND column_name='tenant_id') THEN
        ALTER TABLE backtest_results ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_backtest_results_tenant_id ON backtest_results(tenant_id);
    END IF;

    -- Add tenant_id to billing_summary if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_summary' AND column_name='tenant_id') THEN
        ALTER TABLE billing_summary ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_billing_summary_tenant_id ON billing_summary(tenant_id);
    END IF;

    -- Add tenant_id to optimization_logs if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='optimization_logs' AND column_name='tenant_id') THEN
        ALTER TABLE optimization_logs ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_optimization_logs_tenant_id ON optimization_logs(tenant_id);
    END IF;

    -- Add tenant_id to usage_logs if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='tenant_id') THEN
        ALTER TABLE usage_logs ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_id ON usage_logs(tenant_id);
    END IF;

END $$;