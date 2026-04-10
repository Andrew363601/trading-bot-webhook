// lib/strategy-router.js

/**
 * DYNAMIC STRATEGY ROUTER
 * Routes strategy execution based on the database 'strategy' name.
 * Every strategy file in /lib/strategies must export an async 'run' function.
 */
export async function evaluateStrategy(strategyName, marketData, parameters) {
    try {
        // 1. Sanitize the name to match your file naming convention (lowercase)
        const fileName = strategyName.toLowerCase();
        
        // 2. Dynamic Import
        const strategyPath = `./strategies/${fileName}.js`;
        const strategyModule = await import(strategyPath);

        // 3. Execution (Calls the standard 'run' function inside the file)
        return await strategyModule.run(marketData.macro, marketData.trigger, parameters);

    } catch (error) {
        console.error(`[ROUTER ERROR] No logic file found for strategy: "${strategyName}". Ensure /lib/strategies/${strategyName.toLowerCase()}.js exists.`);
        return { signal: null, error: "LOGIC_FILE_NOT_FOUND" };
    }
}