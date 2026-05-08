-- 001-tenancy-schema.sql
-- Base schema for multi-tenant SaaS isolation

-- 1. Tenants (The root accounts)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  tier TEXT DEFAULT 'FREE', -- FREE|PRO|ENTERPRISE
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Compute Quotas
  max_concurrent_strategies INT DEFAULT 1,
  max_api_calls_per_month INT DEFAULT 100000,
  max_workers INT DEFAULT 1
);

-- 2. Tenant Users (Linking Supabase Auth to Tenants)
CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  auth_user_id UUID, -- Links to auth.users.id
  role TEXT DEFAULT 'TRADER', -- TRADER|ADMIN|VIEWER
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  UNIQUE(tenant_id, email)
);

-- 3. API Keys Vault (Encrypted at rest)
CREATE TABLE IF NOT EXISTS api_keys_vault (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL, -- COINBASE|BYBIT|KRAKEN
  key_name TEXT DEFAULT 'Primary',
  key_encrypted TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  rotated_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(tenant_id, exchange, key_name)
);

-- 4. Tenant Settings
CREATE TABLE IF NOT EXISTS tenant_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  skill_markdown TEXT, -- User-customized SKILL.md
  risk_profile TEXT DEFAULT 'BALANCED', -- CONSERVATIVE|BALANCED|AGGRESSIVE
  default_leverage DECIMAL(5,2) DEFAULT 1.0,
  max_position_size DECIMAL(10,2),
  notification_webhook_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 5. Update existing tables to include tenant_id
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='strategy_config' AND column_name='tenant_id') THEN
        ALTER TABLE strategy_config ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trade_logs' AND column_name='tenant_id') THEN
        ALTER TABLE trade_logs ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='scan_results' AND column_name='tenant_id') THEN
        ALTER TABLE scan_results ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='hermes_core_memory' AND column_name='tenant_id') THEN
        ALTER TABLE hermes_core_memory ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Create indexes for tenant filtering
CREATE INDEX IF NOT EXISTS idx_strategy_tenant ON strategy_config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trades_tenant ON trade_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_scans_tenant ON scan_results(tenant_id);
CREATE INDEX IF NOT EXISTS idx_memory_tenant ON hermes_core_memory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vault_tenant ON api_keys_vault(tenant_id);
