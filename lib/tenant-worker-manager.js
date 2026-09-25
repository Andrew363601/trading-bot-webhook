// lib/tenant-worker-manager.js
import { startSniper, stopSniper } from '../workers/sniper.js';
import { startWatchdog, stopWatchdog } from '../workers/watchdog.js';
import { isTenantBillingActive } from './tenant-context.js';
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
 * PUSH AM35 — full teardown (not just halt) for tenants that fail the
 * billing-aware boot check. Clears worker intervals + closes sockets so a
 * lapsed trial doesn't keep a janitor + sniper alive until process restart.
 */
export async function stopTenantWorkers(tenantId) {
    if (!activeWorkers.has(tenantId)) return;

    try { stopSniper(tenantId); } catch (e) { console.error(`[MANAGER] sniper teardown fault for ${tenantId}:`, e.message); }
    try { stopWatchdog(tenantId); } catch (e) { console.error(`[MANAGER] watchdog teardown fault for ${tenantId}:`, e.message); }

    activeWorkers.delete(tenantId);
    console.log(`[MANAGER] stopped workers for inactive/lapsed tenant ${tenantId}`);
}

/**
 * Billing-aware active check (single source of truth: isTenantBillingActive).
 * ADMIN tenants bypass via billing_tier inside the helper. Async — run
 * sequentially so a 60s sync never fires N parallel Supabase queries.
 */
async function filterBillingActiveTenants(tenants) {
    const active = [];
    for (const t of (tenants || [])) {
        try {
            const billing = await isTenantBillingActive(t.id);
            if (billing.active) active.push(t);
        } catch (e) {
            // Fail-open on check errors (matches helper semantics) so a Supabase
            // blip doesn't tear down healthy workers.
            console.warn(`[MANAGER] billing check failed for ${t.id}, treating as active:`, e.message);
            active.push(t);
        }
    }
    return active;
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

    // PUSH AM35 — billing-aware boot: is_active + subscriptions join, then
    // in-memory filter via isTenantBillingActive (status active/trialing +
    // trial_end + ADMIN bypass). Lapsed tenants get their workers STOPPED.
    let { data: tenants, error } = await supabase
        .from('tenants')
        .select('id, billing_tier, subscriptions(status, trial_end)')
        .eq('is_active', true);

    // Resiliency: if is_active column is missing, fall back to fetching all tenants
    if (error) {
        console.warn('[MANAGER] is_active column missing, falling back to all tenants:', error.message);
        const fallback = await supabase
            .from('tenants')
            .select('id, billing_tier, subscriptions(status, trial_end)');

        if (fallback.error) {
            console.error('[MANAGER] Failed to fetch tenants (fallback also failed):', fallback.error.message);
            return;
        }
        tenants = fallback.data;
    }

    const active = await filterBillingActiveTenants(tenants);

    // Teardown first: tenants that failed the check must not keep workers alive.
    const activeIds = new Set(active.map(t => t.id));
    for (const tenantId of [...activeWorkers.keys()]) {
        if (!activeIds.has(tenantId)) await stopTenantWorkers(tenantId);
    }

    for (const tenant of active) {
        await ensureTenantWorkers(tenant.id);
    }
}

/**
 * Periodic watcher to detect new tenants.
 */
export function startTenantWatcher() {
    setInterval(syncAllTenants, 60000); // Check every minute
}
