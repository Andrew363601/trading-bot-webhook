// hermes-multi-tenant.js
import { syncAllTenants, startTenantWatcher } from './lib/tenant-worker-manager.js';
import { startMCPGateway } from './mcp-gateway.js';

console.log("[NEXUS COMMANDER] Booting multi-tenant autonomous swarm...");

try {
    // 1. Boot the MCP Translation Layer (Single instance for all tenants)
    startMCPGateway();

    // 2. Initial sync of all active tenants
    await syncAllTenants();
    
    // 3. Start the background watcher for new tenants
    startTenantWatcher();

    // Heartbeat monitor
    setInterval(() => {
        console.log(`[HEARTBEAT] Nexus Multi-Tenant Swarm active. Time: ${new Date().toISOString()}`);
    }, 60000); 

} catch (error) {
    console.error("[FATAL SWARM CRASH]:", error.message);
}
