CREATE TABLE IF NOT EXISTS risk_veto_log (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  trade_id INTEGER REFERENCES trade_logs(id) NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price NUMERIC,
  qty NUMERIC,
  leverage NUMERIC,
  reason TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_veto_tenant ON risk_veto_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_risk_veto_created ON risk_veto_log(created_at DESC);
