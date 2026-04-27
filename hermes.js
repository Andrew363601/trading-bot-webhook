// hermes.js
import { startSniper } from './workers/sniper.js';
import { startWatchdog } from './workers/watchdog.js';
import { startMCPGateway } from './mcp-gateway.js'; // 🟢 Added import

console.log("[NEXUS COMMANDER] Booting continuous autonomous swarm...");

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