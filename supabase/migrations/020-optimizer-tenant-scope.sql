-- 020-optimizer-tenant-scope.sql
-- Purpose: The genetic optimizer is now tenant-scoped and writes tenant_id into
-- optimization_logs. Ensure the column exists so inserts do not fail.
--
-- Idempotent and safe to re-run. Only runs if the table already exists.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'optimization_logs'
    ) THEN
        ALTER TABLE public.optimization_logs
            ADD COLUMN IF NOT EXISTS tenant_id uuid;

        CREATE INDEX IF NOT EXISTS idx_optimization_logs_tenant
            ON public.optimization_logs (tenant_id);
    END IF;
END;
$$;
