// hermes-multi-tenant.js
import { syncAllTenants, startTenantWatcher } from './lib/tenant-worker-manager.js';
import { startMCPGateway } from './mcp-gateway.js';

console.log("[NEXUS COMMANDER] Booting multi-tenant autonomous swarm...");

// 🛡️ SECURITY CHECK: Validate MASTER_ENCRYPTION_KEY is present
if (!process.env.MASTER_ENCRYPTION_KEY) {
    console.warn("[WARNING] MASTER_ENCRYPTION_KEY is NOT SET. Tenant API key retrieval will FAIL for all tenants. " +
        "LIVE trading will be blocked. Set this env var in Render dashboard for the Hermes service.");
} else {
    console.log("[SECURITY] MASTER_ENCRYPTION_KEY is present. Tenant vault keys can be decrypted.");
}

async function bootSwarm() {
    try {
        // 1. Boot the MCP Translation Layer (Single instance for all tenants)
        startMCPGateway();

        // 2. Initial sync of all active tenants
        await syncAllTenants();
        console.log("[NEXUS COMMANDER] Tenant sync complete. Workers spawned.");
        
        // 3. Start the background watcher for new tenants
        startTenantWatcher();

        // Heartbeat monitor
        setInterval(() => {
            console.log(`[HEARTBEAT] Nexus Multi-Tenant Swarm active. Time: ${new Date().toISOString()}`);
        }, 60000); 

    } catch (error) {
        console.error("[FATAL SWARM CRASH]:", error.message);
    }
}

bootSwarm();
