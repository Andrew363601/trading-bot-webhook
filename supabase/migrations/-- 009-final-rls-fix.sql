-- 009-final-rls-fix.sql
-- This migration script meticulously cleans up and re-applies Row Level Security (RLS) policies
-- to establish robust multi-tenant data isolation, resolving previous conflicts and access issues.

-- 1. Disable RLS on all affected tables to prevent conflicts during policy drops.
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys_vault DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_config DISABLE ROW LEVEL SECURITY;
ALTER TABLE trade_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE hermes_core_memory DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE favorite_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE billing_summary DISABLE ROW LEVEL SECURITY;
ALTER TABLE optimization_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs DISABLE ROW LEVEL SECURITY;

-- 2. Drop all known conflicting/redundant RLS policies.
-- These policies are from previous attempts and the 002-rls-policies.sql file.
DROP POLICY IF EXISTS "tenant_isolation_policy" ON tenants;
DROP POLICY IF EXISTS "Allow tenant select based on tenant_users" ON tenants;
DROP POLICY IF EXISTS "Can view own tenant" ON tenants;

DROP POLICY IF EXISTS "user_isolation_policy" ON tenant_users;
DROP POLICY IF EXISTS "Allow individual tenant_user select" ON tenant_users;
DROP POLICY IF EXISTS "tenant_users_all_isolation" ON tenant_users;
DROP POLICY IF EXISTS "Can view own tenant_user" ON tenant_users;

DROP POLICY IF EXISTS "vault_isolation_policy" ON api_keys_vault;
DROP POLICY IF EXISTS "api_keys_vault_tenant_isolation" ON api_keys_vault;
DROP POLICY IF EXISTS "Can view own api_keys_vault" ON api_keys_vault;

DROP POLICY IF EXISTS "settings_isolation_policy" ON tenant_settings;
DROP POLICY IF EXISTS "tenant_settings_tenant_isolation" ON tenant_settings;
DROP POLICY IF EXISTS "Can view own tenant_settings" ON tenant_settings;

DROP POLICY IF EXISTS "strategy_isolation_policy" ON strategy_config;
DROP POLICY IF EXISTS "strategy_config_tenant_isolation" ON strategy_config;
DROP POLICY IF EXISTS "Can manage own strategy_config" ON strategy_config;
DROP POLICY IF EXISTS "Enable read access for anon users" ON strategy_config; -- This policy is problematic for isolation

DROP POLICY IF EXISTS "trades_isolation_policy" ON trade_logs;
DROP POLICY IF EXISTS "trade_logs_tenant_isolation" ON trade_logs;
DROP POLICY IF EXISTS "Can view own trade_logs" ON trade_logs;
DROP POLICY IF EXISTS "Enable read access for anon users" ON trade_logs; -- This policy is problematic for isolation

DROP POLICY IF EXISTS "scans_isolation_policy" ON scan_results;
DROP POLICY IF EXISTS "scan_results_tenant_isolation" ON scan_results;
DROP POLICY IF EXISTS "Can view own scan_results" ON scan_results;

DROP POLICY IF EXISTS "memory_isolation_policy" ON hermes_core_memory;
DROP POLICY IF EXISTS "hermes_core_memory_tenant_isolation" ON hermes_core_memory;
DROP POLICY IF EXISTS "Can view own hermes_core_memory" ON hermes_core_memory;

DROP POLICY IF EXISTS "agent_session_logs_isolation_policy" ON agent_session_logs; -- From your current list and my generated script

DROP POLICY IF EXISTS "favorite_assets_tenant_isolation" ON favorite_assets; -- From your current list

-- Drop policies for other tables if they exist
DROP POLICY IF EXISTS "backtest_results_tenant_isolation" ON backtest_results;
DROP POLICY IF EXISTS "billing_summary_tenant_isolation" ON billing_summary;
DROP POLICY IF EXISTS "optimization_logs_tenant_isolation" ON optimization_logs;
DROP POLICY IF EXISTS "Enable read access for all users" ON optimization_logs; -- From your current list
DROP POLICY IF EXISTS "usage_logs_tenant_isolation" ON usage_logs;


-- 3. Re-enable RLS on all relevant tables.
-- This ensures RLS is active before applying the new policies.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE hermes_core_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorite_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE optimization_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;


-- 4. Apply the Corrected and Unified RLS Policies for Tenant Isolation.
-- These policies use a consistent pattern to ensure data is scoped to the authenticated user's tenant.

-- tenant_users: Allow authenticated users to manage (CRUD) their own tenant_user record.
-- This is critical for getting the tenant_id.
CREATE POLICY "tenant_users_all_authenticated" ON tenant_users
  FOR ALL TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- tenants: Allow authenticated users to SELECT the tenant record they belong to.
CREATE POLICY "tenants_select_authenticated" ON tenants
  FOR SELECT TO authenticated
  USING (id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- api_keys_vault: Restrict all operations to ADMIN or TRADER roles within their tenant.
CREATE POLICY "api_keys_vault_all_tenant_scoped" ON api_keys_vault
  FOR ALL TO authenticated
  USING (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() AND role IN ('ADMIN', 'TRADER'))
  ) WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() AND role IN ('ADMIN', 'TRADER'))
  );

-- tenant_settings: Restrict all operations to users within their tenant.
CREATE POLICY "tenant_settings_all_tenant_scoped" ON tenant_settings
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- strategy_config: Restrict all operations to users within their tenant.
CREATE POLICY "strategy_config_all_tenant_scoped" ON strategy_config
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- trade_logs: Restrict all operations to users within their tenant.
CREATE POLICY "trade_logs_all_tenant_scoped" ON trade_logs
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- scan_results: Restrict all operations to users within their tenant.
CREATE POLICY "scan_results_all_tenant_scoped" ON scan_results
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- hermes_core_memory: Restrict all operations to users within their tenant (for lessons).
CREATE POLICY "hermes_core_memory_all_tenant_scoped" ON hermes_core_memory
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- agent_session_logs: Restrict all operations to users within their tenant (for operational logs).
CREATE POLICY "agent_session_logs_all_tenant_scoped" ON agent_session_logs
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- favorite_assets: Restrict all operations to users within their tenant.
CREATE POLICY "favorite_assets_all_tenant_scoped" ON favorite_assets
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

-- Placeholder RLS for other tables (uncomment and adjust as needed)
CREATE POLICY "backtest_results_all_tenant_scoped" ON backtest_results
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

CREATE POLICY "billing_summary_all_tenant_scoped" ON billing_summary
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

CREATE POLICY "optimization_logs_all_tenant_scoped" ON optimization_logs
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));

CREATE POLICY "usage_logs_all_tenant_scoped" ON usage_logs
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid()));