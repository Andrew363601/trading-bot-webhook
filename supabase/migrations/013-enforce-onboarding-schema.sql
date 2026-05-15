-- 013-enforce-onboarding-schema.sql
-- Comprehensive and fully idempotent script to fix database schema, onboarding triggers, and backfill missing data.
-- Run this in your Supabase SQL editor.

-- ============================================================
-- 1. ENUM AND TABLES SETUP
-- ============================================================

-- Create subscription_status enum if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid');
    END IF;
END
$$;

-- Create subscriptions table if not exists
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid UNIQUE,
    stripe_customer_id text,
    stripe_subscription_id text,
    status subscription_status DEFAULT 'trialing'::subscription_status,
    tier text DEFAULT 'RETAIL'::text,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    trial_start timestamp with time zone,
    trial_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT subscriptions_pkey PRIMARY KEY (id)
);

-- Ensure tenants table has the latest billing columns
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS billing_tier text DEFAULT 'FREE_TRIAL'::text;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS subscription_active boolean DEFAULT true;

-- ============================================================
-- 2. CONSTRAINT RECONCILIATION
-- (Wrapping ALTER TABLE commands in DO blocks for safety)
-- ============================================================

-- Foreign Key: subscriptions -> tenants
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- Unique Constraint: tenant_users -> auth_user_id (CRITICAL FOR DEDUP)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'tenant_users' AND constraint_name = 'tenant_users_auth_user_id_key'
    ) THEN
        ALTER TABLE public.tenant_users ADD CONSTRAINT tenant_users_auth_user_id_key UNIQUE (auth_user_id);
    END IF;
END
$$;

-- Foreign Key: tenant_users -> tenants
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'tenant_users' AND constraint_name = 'tenant_users_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.tenant_users ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- ============================================================
-- 3. ONBOARDING TRIGGER LOGIC
-- ============================================================

-- Robust function for onboarding a new user
CREATE OR REPLACE FUNCTION public.handle_new_user_onboarding()
RETURNS TRIGGER AS $$
DECLARE
    new_tenant_id uuid;
    existing_tenant uuid;
BEGIN
    -- 🛡️ DEDUP GUARD: Check if user already exists in registry
    SELECT tenant_id INTO existing_tenant
    FROM public.tenant_users
    WHERE auth_user_id = NEW.id
    LIMIT 1;

    IF existing_tenant IS NOT NULL THEN
        RAISE LOG 'ONBOARDING SKIP: User % already registered to tenant %', NEW.id, existing_tenant;
        RETURN NEW;
    END IF;

    -- 1. Create a primary tenant for the user
    -- Uses email prefix + unique ID to ensure slug/name uniqueness
    INSERT INTO public.tenants (name, slug, billing_tier, subscription_active)
    VALUES (
        COALESCE(NEW.email, 'User-' || substring(NEW.id::text, 1, 8)) || ' Portfolio',
        'nexus-' || substring(NEW.id::text, 1, 8),
        'FREE_TRIAL',
        true
    )
    RETURNING id INTO new_tenant_id;

    -- 2. Link user to tenant with TRIAL role
    INSERT INTO public.tenant_users (tenant_id, auth_user_id, email, role)
    VALUES (new_tenant_id, NEW.id, NEW.email, 'TRIAL');

    -- 3. Initialize default trial subscription
    INSERT INTO public.subscriptions (tenant_id, status, tier, trial_start, trial_end)
    VALUES (new_tenant_id, 'trialing', 'RETAIL', NOW(), NOW() + INTERVAL '14 days');

    -- 4. Initialize basic tenant settings
    INSERT INTO public.tenant_settings (tenant_id, risk_profile, default_leverage)
    VALUES (new_tenant_id, 'BALANCED', 1.0)
    ON CONFLICT (tenant_id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'ONBOARDING ERROR for User %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-apply trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_onboarding();

-- ============================================================
-- 4. AUTOMATIC BACKFILL — HELPER FUNCTION (must be declared
--    BEFORE the DO block that calls it)
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user_onboarding_manual(user_id uuid, user_email text)
RETURNS void AS $$
DECLARE
    new_tenant_id uuid;
BEGIN
    INSERT INTO public.tenants (name, slug, billing_tier, subscription_active)
    VALUES (
        COALESCE(user_email, 'User-' || substring(user_id::text, 1, 8)) || ' Portfolio',
        'nexus-bf-' || substring(user_id::text, 1, 8),
        'FREE_TRIAL',
        true
    )
    RETURNING id INTO new_tenant_id;

    INSERT INTO public.tenant_users (tenant_id, auth_user_id, email, role)
    VALUES (new_tenant_id, user_id, user_email, 'TRIAL')
    ON CONFLICT (auth_user_id) DO NOTHING;

    INSERT INTO public.subscriptions (tenant_id, status, tier, trial_start, trial_end)
    VALUES (new_tenant_id, 'trialing', 'RETAIL', NOW(), NOW() + INTERVAL '14 days')
    ON CONFLICT (tenant_id) DO NOTHING;

    INSERT INTO public.tenant_settings (tenant_id, risk_profile, default_leverage)
    VALUES (new_tenant_id, 'BALANCED', 1.0)
    ON CONFLICT (tenant_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Now backfill — function exists before this runs
DO $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN 
        SELECT id, email FROM auth.users 
        WHERE id NOT IN (SELECT auth_user_id FROM public.tenant_users WHERE auth_user_id IS NOT NULL)
    LOOP
        RAISE LOG 'BACKFILLING: Creating registry for User % (%)', user_record.id, user_record.email;
        PERFORM public.handle_new_user_onboarding_manual(user_record.id, user_record.email);
    END LOOP;
END
$$;

-- Trigger a final grant check to ensure permissions are correct
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
