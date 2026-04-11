// lib/strategy-router.js

// 1. STATIC IMPORTS (Forces Vercel to bundle these files in production)
import { run as runCoherence } from './strategies/coherence_v1.js';
import { run as runDogeScalper } from './strategies/doge_scalper_v1.js';
import { run as runDogeHfScalper } from './strategies/doge_hf_scalper_v1.js';

export async function evaluateStrategy(strategyName, marketData, parameters) {
    try {
        // 2. EXPLICIT ROUTING
        switch (strategyName.toUpperCase()) {
            case 'COHERENCE_V1':
                return await runCoherence(marketData.macro, marketData.trigger, parameters);
            
            case 'DOGE_SCALPER_V1':
                return await runDogeScalper(marketData.macro, marketData.trigger, parameters);
            
            case 'DOGE_HF_SCALPER_V1':
                return await runDogeHfScalper(marketData.macro, marketData.trigger, parameters);
            
            default:
                console.error(`[ROUTER ERROR] Strategy ${strategyName} is not mapped in strategy-router.js`);
                return { signal: null, error: "LOGIC_FILE_NOT_MAPPED" };
        }

    } catch (error) {
        console.error(`[ROUTER FATAL] ${strategyName}:`, error.message);
        return { signal: null, error: error.message };
    }
}