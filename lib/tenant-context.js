// lib/tenant-context.js
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

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
          global: { WebSocket: WebSocket },
          realtime: { transport: WebSocket }
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

/**
 * Checks if a tenant has configured Coinbase API keys.
 */
export async function checkHasCoinbaseKeys(tenantId) {
    const supabase = getTenantClient();
    try {
        const { data, error } = await supabase
            .from('api_keys_vault')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('exchange', 'COINBASE')
            .eq('is_active', true)
            .single();
        if (error || !data) return false;
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 🔒 BILLING GUARD (defense-in-depth)
 * Determines whether a tenant is permitted to run/execute strategies based on
 * their subscription state. Workers use the SERVICE ROLE and therefore BYPASS RLS,
 * so this guard is the authoritative runtime check that prevents trading after a
 * subscription is canceled or a free trial has expired.
 *
 * Returns { active: boolean, reason: string, status: string|null }.
 */
export async function isTenantBillingActive(tenantId) {
    const supabase = getTenantClient();
    try {
        // 1) Subscription record is the source of truth for status + trial window.
        const { data: sub } = await supabase
            .from('subscriptions')
            .select('status, trial_end, current_period_end, cancel_at_period_end')
            .eq('tenant_id', tenantId)
            .single();

        // 2) tenants.subscription_active is the fast-path flag written by the webhook.
        const { data: tenant } = await supabase
            .from('tenants')
            .select('subscription_active')
            .eq('id', tenantId)
            .single();

        const now = Date.now();

        // Hard stop: explicit cancel / dunning states.
        if (sub?.status && ['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
            return { active: false, reason: `Subscription ${sub.status}`, status: sub.status };
        }

        // Trialing but the trial window has elapsed.
        if (sub?.status === 'trialing' && sub?.trial_end && new Date(sub.trial_end).getTime() < now) {
            return { active: false, reason: 'Free trial expired', status: 'trialing_expired' };
        }

        // Past due beyond the paid period.
        if (sub?.status === 'past_due' && sub?.current_period_end && new Date(sub.current_period_end).getTime() < now) {
            return { active: false, reason: 'Subscription past due', status: 'past_due' };
        }

        // Fast-path flag explicitly disabled by webhook/cron.
        if (tenant && tenant.subscription_active === false) {
            return { active: false, reason: 'Billing inactive', status: sub?.status || 'inactive' };
        }

        return { active: true, reason: 'OK', status: sub?.status || 'active' };
    } catch (e) {
        // FAIL-SAFE: if we cannot determine billing state, do NOT block existing tenants
        // (avoids accidental outage), but surface the error for monitoring.
        console.warn(`[BILLING_GUARD] Could not resolve billing for ${tenantId}: ${e.message}`);
        return { active: true, reason: 'Billing check unavailable (fail-open)', status: null };
    }
}

/**
 * Forces all of a tenant's strategies to is_active = false. Used by the Stripe
 * webhook (on cancel) and the trial-end sweep. Idempotent.
 */
export async function deactivateTenantStrategies(tenantId, reason = 'BILLING') {
    const supabase = getTenantClient();
    try {
        const { error } = await supabase
            .from('strategy_config')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('tenant_id', tenantId)
            .eq('is_active', true);
        if (error) throw error;
        return true;
    } catch (e) {
        console.error(`[BILLING_GUARD] Failed to deactivate strategies for ${tenantId}: ${e.message}`);
        return false;
    }
}
