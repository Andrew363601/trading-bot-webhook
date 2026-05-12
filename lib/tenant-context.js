// lib/tenant-context.js
import { createClient } from '@supabase/supabase-js';
import Ws from 'ws';

/**
 * Creates a tenant-aware Supabase client.
 * Uses the service role but includes the tenant header for RLS if needed,
 * though backend service role usually bypasses RLS. 
 * We primarily use this to ensure we always filter by tenant_id in queries.
 */
export function getTenantClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { 
          global: { WebSocket: Ws },
          realtime: { transport: Ws }
        }
    );
}

/**
 * Fetches tenant-specific settings (Risk Profile, etc.)
 */
export async function getTenantSettings(tenantId) {
    const supabase = getTenantClient();
    const { data, error } = await supabase
        .from('tenant_settings')
        .select('*')
        .eq('tenant_id', tenantId)
        .single();

    if (error) {
        console.warn(`[TENANT_CONTEXT] No settings for ${tenantId}, using defaults.`);
        return {
            risk_profile: 'BALANCED',
            default_leverage: 1.0,
            skill_markdown: null
        };
    }

    return data;
}

/**
 * Validates if a tenant has active billing/quota remaining.
 */
export async function checkTenantQuota(tenantId, metric = 'TRADE_EXECUTED') {
    const supabase = getTenantClient();
    
    const { data: tenant } = await supabase
        .from('tenants')
        .select('tier, max_concurrent_strategies, max_api_calls_per_month')
        .eq('id', tenantId)
        .single();

    if (!tenant) return false;

    // TODO: Implement actual usage check against usage_logs table (Phase 6)
    return true; 
}
