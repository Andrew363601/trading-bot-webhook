// lib/usage-meter.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Records a usage event for a tenant.
 */
export async function recordUsage(tenantId, metric, quantity = 1) {
    try {
        const { error } = await supabase
            .from('usage_logs')
            .insert({
                tenant_id: tenantId,
                metric,
                quantity
            });
            
        if (error) throw error;
    } catch (error) {
        console.error(`[USAGE_METER] Failed to log ${metric} for ${tenantId}:`, error.message);
    }
}
