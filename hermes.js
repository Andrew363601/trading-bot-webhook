// hermes.js
import { startSniper } from './workers/sniper.js';
import { startWatchdog } from './workers/watchdog.js';

console.log("[NEXUS COMMANDER] Booting continuous autonomous swarm...");

try {
    // 1. Boot the execution engine (Tape Reader)
    startSniper();
    
    // 2. Boot the risk manager (Trailing Stops / SL)
    startWatchdog();

    // 3. Heartbeat monitor to keep the Render process alive and log uptime
    setInterval(() => {
        console.log(`[HEARTBEAT] Nexus Swarm active. Memory usage: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
    }, 60000); // Logs every 60 seconds

} catch (error) {
    console.error("[FATAL SWARM CRASH]:", error.message);
}