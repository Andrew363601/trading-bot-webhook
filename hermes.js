// hermes.js
import { startSniper } from './workers/sniper.js';
import { startWatchdog } from './workers/watchdog.js';
import { startMCPGateway } from './mcp-gateway.js'; // 🟢 Added import

console.log("[NEXUS COMMANDER] Booting continuous autonomous swarm...");

// 🛡️ SECURITY CHECK: Validate MASTER_ENCRYPTION_KEY is present
if (!process.env.MASTER_ENCRYPTION_KEY) {
    console.warn("[WARNING] MASTER_ENCRYPTION_KEY is NOT SET. Tenant API key retrieval will FAIL. " +
        "LIVE trading will be blocked. Set this env var in Render dashboard.");
} else {
    console.log("[SECURITY] MASTER_ENCRYPTION_KEY is present. Tenant vault keys can be decrypted.");
}

try {
    // 1. Boot the MCP Translation Layer
    startMCPGateway(); // 🟢 Added boot command

    // 2. Boot the execution engine (Tape Reader)
    startSniper();
    
    // 3. Boot the risk manager (Trailing Stops / SL)
    startWatchdog();

    // Heartbeat monitor
    setInterval(() => {
        console.log(`[HEARTBEAT] Nexus Swarm active. Memory usage: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
    }, 60000); 

} catch (error) {
    console.error("[FATAL SWARM CRASH]:", error.message);
}