-- 036-agent-tool-calls-rls.sql
-- Row-level security for agent_tool_calls: tenant isolation

ALTER TABLE agent_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_tool_calls_tenant_scoped" ON agent_tool_calls;
CREATE POLICY "agent_tool_calls_tenant_scoped" ON agent_tool_calls
  FOR ALL USING (tenant_id = (SELECT tenant_id FROM tenant_users WHERE auth_user_id = auth.uid() LIMIT 1));

-- Grant service role full access
DROP POLICY IF EXISTS "agent_tool_calls_service_role" ON agent_tool_calls;
CREATE POLICY "agent_tool_calls_service_role" ON agent_tool_calls
  FOR ALL USING (auth.role() = 'service_role');
