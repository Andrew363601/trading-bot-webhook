// hermes-multi-tenant.js
import { syncAllTenants, startTenantWatcher } from './lib/tenant-worker-manager.js';
import { startMCPGateway } from './mcp-gateway.js';
import { startShadowPortfolio } from './workers/shadow-portfolio.js';

// 🛡️ AM1 — transport failures (ETIMEDOUT/ENETUNREACH on CF-fronted hosts) must
// never kill the swarm. Contain + log (the log line names the failing host);
// the next sweep tick retries naturally. Mirrors ENGINE 3's WS-guard philosophy.
let am1Rejections = 0;
// PUSH AM35 — cause-aware containment: AggregateError (DNS failures) carries
// the attempted IPs in .cause.errors; fetch failures carry the failing URL in
// .cause. Log both so the next wave names the dependency instead of a bare code.
function describeTransportFailure(reason) {
    const parts = [];
    if (reason?.code) parts.push(`code=${reason.code}`);
    const cause = reason?.cause;
    if (cause) {
        if (cause.code) parts.push(`cause.code=${cause.code}`);
        if (Array.isArray(cause.errors)) parts.push(`cause.errors=[${cause.errors.map(e => e?.code || e?.message).join(', ').slice(0, 200)}]`);
        else if (cause.message) parts.push(`cause=${String(cause.message).slice(0, 150)}`);
    }
    const host = typeof reason?.message === 'string' ? (reason.message.match(/https?:\/\/[^\s"']+/) || [])[0] : null;
    if (host) parts.push(`host=${host}`);
    return parts.join(' ');
}
process.on('unhandledRejection', (reason) => {
    am1Rejections++;
    console.error(`[SWARM] Unhandled rejection CONTAINED (#${am1Rejections}):`,
        describeTransportFailure(reason), String(reason?.message || reason).slice(0, 300));
});
process.on('uncaughtException', (err) => {
    console.error('[SWARM] Uncaught exception CONTAINED:',
        describeTransportFailure(err), String(err?.message || err).slice(0, 300));
});

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

        // 2. Boot the shadow portfolio evaluator (VETO accuracy)
        startShadowPortfolio();

        // 3. Initial sync of all active tenants
        await syncAllTenants();
        console.log("[NEXUS COMMANDER] Tenant sync complete. Workers spawned.");
        
        // 4. Start the background watcher for new tenants
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
