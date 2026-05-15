// lib/tenant-worker-manager.js
import { startSniper } from '../workers/sniper.js';
import { startWatchdog } from '../workers/watchdog.js';
import { createClient } from '@supabase/supabase-js';

import WebSocket from 'ws';

const activeWorkers = new Map(); // tenantId => { sniper, watchdog }

/**
 * Spawns workers for a tenant if not already running.
 */
export async function ensureTenantWorkers(tenantId) {
    if (activeWorkers.has(tenantId)) return;

    console.log(`[MANAGER] Spawning workers for tenant ${tenantId}`);
    
    // In a production environment, you might spawn these as child processes or in a cluster.
    // Here we run them as async functions within the same process for simplicity.
    const sniper = startSniper(tenantId);
    const watchdog = startWatchdog(tenantId);

    activeWorkers.set(tenantId, { sniper, watchdog });
}

/**
 * Syncs all active tenants from the database.
 */
export async function syncAllTenants() {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { 
          global: { WebSocket: WebSocket },
          realtime: { transport: WebSocket }
        }
    );

    // Try with is_active filter first (requires the column to exist)
    let { data: tenants, error } = await supabase
        .from('tenants')
        .select('id')
        .eq('is_active', true);

    // Resiliency: if is_active column is missing, fall back to fetching all tenants
    if (error) {
        console.warn('[MANAGER] is_active column missing, falling back to all tenants:', error.message);
        const fallback = await supabase
            .from('tenants')
            .select('id');

        if (fallback.error) {
            console.error('[MANAGER] Failed to fetch tenants (fallback also failed):', fallback.error.message);
            return;
        }
        tenants = fallback.data;
    }

    for (const tenant of tenants) {
        await ensureTenantWorkers(tenant.id);
    }
}

/**
 * Periodic watcher to detect new tenants.
 */
export function startTenantWatcher() {
    setInterval(syncAllTenants, 60000); // Check every minute
}
