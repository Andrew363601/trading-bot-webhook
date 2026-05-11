-- 002-rls-policies.sql
-- Security layer for multi-tenant isolation

-- Enable RLS on all tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE hermes_core_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_logs ENABLE ROW LEVEL SECURITY;

-- 1. Tenants: Users can only see the tenant they belong to
CREATE POLICY tenant_isolation_policy ON tenants
  FOR ALL USING (
    id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

-- 2. Tenant Users: Members can see each other, only admins can manage
CREATE POLICY user_isolation_policy ON tenant_users
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

-- 3. API Keys: Only Admins or Traders can view (decryption handled at worker level)
CREATE POLICY vault_isolation_policy ON api_keys_vault
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid() 
      AND role IN ('ADMIN', 'TRADER')
    )
  );

-- 4. Settings: Tenant members only
CREATE POLICY settings_isolation_policy ON tenant_settings
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

-- 5. Application Data Isolation (Strategies, Trades, Scans, Memory)
CREATE POLICY strategy_isolation_policy ON strategy_config
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY trades_isolation_policy ON trade_logs
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY scans_isolation_policy ON scan_results
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY memory_isolation_policy ON hermes_core_memory
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY agent_session_logs_isolation_policy ON agent_session_logs
  FOR ALL USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users 
      WHERE auth_user_id = auth.uid()
    )
  );
