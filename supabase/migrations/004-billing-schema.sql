-- 004-add-billing-tables.sql
-- Tables for tracking usage and billing

CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    metric TEXT NOT NULL, -- TRADE_EXECUTED | API_CALL | SCAN
    quantity INT DEFAULT 1,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    month TEXT NOT NULL, -- e.g. "2026-05"
    trades_executed INT DEFAULT 0,
    api_calls INT DEFAULT 0,
    total_usd DECIMAL(10, 2) DEFAULT 0,
    is_paid BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(tenant_id, month)
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_logs(tenant_id, timestamp);
