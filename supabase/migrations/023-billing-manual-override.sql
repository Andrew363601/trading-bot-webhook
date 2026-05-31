-- 023-billing-manual-override.sql
-- Purpose: Honor an admin "manual override" inside the scheduled billing sweep
-- introduced by migration 017. Without this, the cron job will silently turn
-- off strategies for internal/test tenants that intentionally have no Stripe
-- subscription row.
--
-- Manual override rule (mirrored from lib/tenant-context.js::isTenantBillingActive):
--   tenants.subscription_active = true
--     AND tenants.billing_tier IN ('RETAIL','PRO','INSTITUTIONAL','ADMIN')
-- → the tenant is considered active even if subscriptions.* is canceled / null /
--   past trial. This lets you bless test accounts without a live Stripe charge.
--
-- Idempotent and safe to re-run. Replaces the function body in place.

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
        LEFT JOIN public.tenants t ON t.id = s.tenant_id
        WHERE
            (
                s.status IN ('canceled', 'unpaid', 'incomplete_expired')
                OR (s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end < now())
                OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end < now())
            )
            -- 🛠️ MANUAL OVERRIDE: skip tenants explicitly blessed by an admin.
            AND NOT (
                coalesce(t.subscription_active, false) = true
                AND upper(coalesce(t.billing_tier, '')) IN ('RETAIL','PRO','INSTITUTIONAL','ADMIN')
            )
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

    -- Sync the fast-path flag, again respecting the manual override.
    UPDATE public.tenants t
    SET subscription_active = false,
        updated_at = now()
    FROM public.subscriptions s
    WHERE t.id = s.tenant_id
      AND t.subscription_active = true
      AND NOT (
            coalesce(t.subscription_active, false) = true
            AND upper(coalesce(t.billing_tier, '')) IN ('RETAIL','PRO','INSTITUTIONAL','ADMIN')
      )
      AND (
            s.status IN ('canceled', 'unpaid', 'incomplete_expired')
            OR (s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end < now())
            OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end < now())
      );
END;
$$;
