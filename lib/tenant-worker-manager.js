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

    const { data: tenants, error } = await supabase
        .from('tenants')
        .select('id')
        .eq('is_active', true);

    if (error) {
        console.error('[MANAGER] Failed to fetch tenants:', error.message);
        return;
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
