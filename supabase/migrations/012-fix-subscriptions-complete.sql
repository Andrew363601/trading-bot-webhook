-- 012-fix-subscriptions-complete.sql
-- Fully idempotent script that fixes the subscription + auth redirect flow.
-- Safe to run multiple times — all statements use IF NOT EXISTS / DROP ... IF EXISTS.

-- ============================================================
-- 1. CREATE ENUM (safe — wrapped in DO block to handle existing)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid');
    END IF;
END
$$;

-- ============================================================
-- 2. CREATE SUBSCRIPTIONS TABLE (idempotent)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status subscription_status DEFAULT 'trialing',
    tier TEXT DEFAULT 'RETAIL',
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    trial_start TIMESTAMPTZ,
    trial_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. ADD COLUMNS TO TENANTS TABLE (idempotent)
-- ============================================================
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_tier TEXT DEFAULT 'FREE_TRIAL';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_active BOOLEAN DEFAULT TRUE;

-- ============================================================
-- 4. ENSURE FOREIGN KEY EXISTS ON tenant_users.tenant_id → tenants.id
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'tenant_users' AND kcu.column_name = 'tenant_id' AND tc.constraint_type = 'FOREIGN KEY'
    ) THEN
        ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- ============================================================
-- 5. ENSURE FOREIGN KEY EXISTS ON subscriptions.tenant_id → tenants.id
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'subscriptions' AND kcu.column_name = 'tenant_id' AND tc.constraint_type = 'FOREIGN KEY'
    ) THEN
        ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- ============================================================
-- 6. ADD UNIQUE CONSTRAINT ON tenant_users.auth_user_id (prevents duplicate signups)
-- ============================================================
ALTER TABLE tenant_users ADD CONSTRAINT IF NOT EXISTS tenant_users_auth_user_id_key UNIQUE (auth_user_id);

-- ============================================================
-- 7. CREATE/REPLACE THE TRIGGER FUNCTION WITH DEDUP GUARD
-- ============================================================
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

    -- 2. Add the user to tenant_users as TRIAL role
    INSERT INTO tenant_users (tenant_id, auth_user_id, role)
    VALUES (new_tenant_id, NEW.id, 'TRIAL');

    -- 3. Initialize subscription record for 14-day trial
    INSERT INTO subscriptions (tenant_id, status, tier, trial_start, trial_end)
    VALUES (new_tenant_id, 'trialing', 'RETAIL', NOW(), NOW() + INTERVAL '14 days');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 8. CREATE/REPLACE THE TRIGGER
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_onboarding();

-- ============================================================
-- 9. ENABLE RLS ON SUBSCRIPTIONS (if not already)
-- ============================================================
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 10. DROP OLD SUBSCRIPTIONS RLS POLICIES TO AVOID CONFLICTS
-- ============================================================
DROP POLICY IF EXISTS "subscriptions_all_tenant_scoped" ON subscriptions;

-- ============================================================
-- 11. CREATE CORRECT RLS POLICY FOR SUBSCRIPTIONS
--     Allows service_role (webhook) to write + authenticated users to read their own
-- ============================================================
CREATE POLICY "subscriptions_all_tenant_scoped" ON subscriptions
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- Allow service_role (webhook, create-checkout-session) full access
DROP POLICY IF EXISTS "subscriptions_service_role_all" ON subscriptions;
CREATE POLICY "subscriptions_service_role_all" ON subscriptions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);