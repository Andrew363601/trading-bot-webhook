-- 017-cancellation-enforcement.sql
-- Purpose: Enforce that a tenant whose subscription is canceled OR whose free trial
-- has expired can no longer run trading strategies.
--
-- Layered enforcement (defense-in-depth):
--   1. Stripe webhook (application layer)  -> handles real-time cancel/downgrade.
--   2. Worker billing guard (runtime)       -> blocks execution each cycle.
--   3. THIS migration (database layer)       -> a scheduled sweep that catches trials
--      that lapse without any Stripe event firing (Stripe does not send an event the
--      moment a trial ends if there is no payment method / subscription transition).
--
-- This file is idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Reusable function: deactivate strategies for billing-lapsed tenants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_billing_strategy_lockdown()
RETURNS TABLE (affected_tenant uuid, strategies_disabled integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH lapsed AS (
        SELECT s.tenant_id
        FROM public.subscriptions s
        WHERE
            -- Explicitly terminal / dunning states
            s.status IN ('canceled', 'unpaid', 'incomplete_expired')
            -- Trials whose window has elapsed
            OR (s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end < now())
            -- Past-due beyond the paid period
            OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end < now())
    ),
    disabled AS (
        UPDATE public.strategy_config sc
        SET is_active = false,
            updated_at = now()
        FROM lapsed l
        WHERE sc.tenant_id = l.tenant_id
          AND sc.is_active = true
        RETURNING sc.tenant_id
    )
    SELECT d.tenant_id AS affected_tenant, COUNT(*)::int AS strategies_disabled
    FROM disabled d
    GROUP BY d.tenant_id;

    -- Keep the fast-path flag on tenants in sync for lapsed accounts.
    UPDATE public.tenants t
    SET subscription_active = false,
        updated_at = now()
    FROM public.subscriptions s
    WHERE t.id = s.tenant_id
      AND t.subscription_active = true
      AND (
            s.status IN ('canceled', 'unpaid', 'incomplete_expired')
            OR (s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end < now())
            OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end < now())
      );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Schedule the sweep hourly via pg_cron (if available).
--    NOTE: pg_cron must be enabled for your Supabase project. If it is not
--    enabled, this block is skipped gracefully; the webhook + worker guard
--    still provide full protection. To enable manually, run (as a superuser
--    or via the Supabase dashboard "Database > Extensions"):
--        CREATE EXTENSION IF NOT EXISTS pg_cron;
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Remove any prior schedule with the same name to stay idempotent.
        PERFORM cron.unschedule(jobid)
        FROM cron.job
        WHERE jobname = 'billing_strategy_lockdown';

        PERFORM cron.schedule(
            'billing_strategy_lockdown',
            '0 * * * *',  -- every hour, on the hour
            $cron$ SELECT public.enforce_billing_strategy_lockdown(); $cron$
        );
        RAISE NOTICE 'Scheduled pg_cron job: billing_strategy_lockdown (hourly).';
    ELSE
        RAISE NOTICE 'pg_cron not installed; skipping schedule. Webhook + worker guard remain active.';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. One-time immediate sweep so existing lapsed tenants are locked down now.
-- ---------------------------------------------------------------------------
SELECT public.enforce_billing_strategy_lockdown();
