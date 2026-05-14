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
CREATE OR REPLACE FUNCTION public.handle_new_user_onboarding()
RETURNS TRIGGER AS $$
DECLARE
    new_tenant_id UUID;
BEGIN
    -- 1. Create a new tenant for the user
    INSERT INTO tenants (name)
    VALUES (NEW.email || ' Tenant')
    RETURNING id INTO new_tenant_id;

    -- 2. Add the user to tenant_users as TRIAL role (not ADMIN by default for new public users)
    -- Note: If we want to allow specific emails to be ADMIN, we can check NEW.email here
    INSERT INTO tenant_users (tenant_id, auth_user_id, role)
    VALUES (new_tenant_id, NEW.id, 'TRIAL');

    -- 3. Initialize subscription record for 14-day trial
    INSERT INTO subscriptions (tenant_id, status, tier, trial_start, trial_end)
    VALUES (new_tenant_id, 'trialing', 'RETAIL', NOW(), NOW() + INTERVAL '14 days');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for public user creation (uncomment if you want to automate this in Supabase)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_onboarding();
