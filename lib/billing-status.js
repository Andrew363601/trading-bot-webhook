import { isTenantBillingActive, getTenantClient } from './tenant-context.js';

/**
 * Shared server-side guard / query to fetch comprehensive billing status
 * for a tenant, including billing gate result, active/paused strategy counts, and tier.
 */
export async function getBillingStatus(tenantId) {
    if (!tenantId) {
        return { active: false, reason: 'No tenant ID provided', pausedCount: 0, tier: 'FREE_TRIAL' };
    }

    const gate = await isTenantBillingActive(tenantId);
    const supabase = getTenantClient();

    let pausedCount = 0;
    let tier = 'FREE_TRIAL';

    try {
        const { data: pausedConfigs, error: pausedError } = await supabase
            .from('strategy_config')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('billing_paused', true);

        if (!pausedError && pausedConfigs) {
            pausedCount = pausedConfigs.length;
        }

        const { data: tenant } = await supabase
            .from('tenants')
            .select('billing_tier')
            .eq('id', tenantId)
            .single();

        if (tenant?.billing_tier) {
            tier = tenant.billing_tier;
        }
    } catch (err) {
        console.warn(`[BILLING_STATUS] Error fetching paused count / tier for ${tenantId}:`, err.message);
    }

    return {
        active: gate.active,
        reason: gate.reason,
        status: gate.status,
        pausedCount,
        tier
    };
}
