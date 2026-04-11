/**
 * DYNAMIC STRATEGY ROUTER
 * Routes strategy execution based on the database 'strategy' name.
 * Every strategy file in /lib/strategies must export an async 'run' function.
 */

export async function evaluateStrategy(strategyName, marketData, parameters) {
    try {
        // 1. Sanitize the DB name to match your file naming convention (lowercase)
        // Example: "BTC_BREAKOUT_V1" becomes "btc_breakout_v1.js"
        const fileName = strategyName.toLowerCase();
        
        // 2. Dynamic Import - only loads the file if the name matches
        const strategyPath = `./strategies/${fileName}.js`;
        const strategyModule = await import(strategyPath);

        // 3. Execution - pushes all unique parameters directly to the specific logic
        return await strategyModule.run(marketData.macro, marketData.trigger, parameters);

    } catch (error) {
        // 4. Error Handling - if the file doesn't exist or logic breaks
        console.error(`[ROUTER ERROR] Strategy mapping failed for "${strategyName}". Ensure /lib/strategies/${strategyName.toLowerCase()}.js exists and exports a run() function. Details: ${error.message}`);
        
        // Return a null signal to prevent accidental trades
        return { signal: null, error: "LOGIC_FILE_NOT_MAPPED_OR_FAILED" };
    }
}