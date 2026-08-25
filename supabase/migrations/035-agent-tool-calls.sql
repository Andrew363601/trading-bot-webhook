CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  trade_id INTEGER REFERENCES trade_logs(id) NULL,
  scan_id INTEGER REFERENCES scan_results(id) NULL,
  tool_name TEXT NOT NULL,
  params_snapshot JSONB,
  response_summary TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'success',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant ON agent_tool_calls(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_trade ON agent_tool_calls(trade_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON agent_tool_calls(created_at DESC);
