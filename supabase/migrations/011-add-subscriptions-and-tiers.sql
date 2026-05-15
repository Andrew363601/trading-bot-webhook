-- 011-add-subscriptions-and-tiers.sql
-- This migration adds subscription tracking for Stripe integration

-- Create enum for subscription status
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid');

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status subscription_status DEFAULT 'trialing',
    tier TEXT DEFAULT 'RETAIL', -- RETAIL, PRO, INSTITUTIONAL
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    trial_start TIMESTAMPTZ,
    trial_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Add RLS policy for subscriptions
CREATE POLICY "subscriptions_all_tenant_scoped" ON subscriptions
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- Update tenants table to include a billing_status column if needed (optional, using subscriptions table instead)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_tier TEXT DEFAULT 'FREE_TRIAL';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_active BOOLEAN DEFAULT TRUE;

-- Add function to handle user creation and default to TRIAL role
-- Guarded: skips if user already has a tenant (prevents duplicate signups)
CREATE OR REPLACE FUNCTION public.handle_new_user_onboarding()
RETURNS TRIGGER AS $$
DECLARE
    new_tenant_id UUID;
    existing_tenant UUID;
BEGIN
    -- 🛡️ DEDUP GUARD: Skip if this user already has a tenant_users row
    SELECT tenant_id INTO existing_tenant
    FROM public.tenant_users
    WHERE auth_user_id = NEW.id
    LIMIT 1;

    IF existing_tenant IS NOT NULL THEN
        RAISE LOG 'User % already has tenant %, skipping onboarding.', NEW.id, existing_tenant;
        RETURN NEW;
    END IF;

    -- 1. Create a new tenant for the user
    INSERT INTO tenants (name)
    VALUES (NEW.email || ' Tenant')
    RETURNING id INTO new_tenant_id;

    -- 2. Add the user to tenant_users as TRIAL role (not ADMIN by default for new public users)
    INSERT INTO tenant_users (tenant_id, auth_user_id, role)
    VALUES (new_tenant_id, NEW.id, 'TRIAL');

    -- 3. Initialize subscription record for 14-day trial
    INSERT INTO subscriptions (tenant_id, status, tier, trial_start, trial_end)
    VALUES (new_tenant_id, 'trialing', 'RETAIL', NOW(), NOW() + INTERVAL '14 days');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add unique constraint on tenant_users.auth_user_id to prevent duplicates at DB level
ALTER TABLE tenant_users ADD CONSTRAINT IF NOT EXISTS tenant_users_auth_user_id_key UNIQUE (auth_user_id);

-- Trigger for public user creation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_onboarding();
