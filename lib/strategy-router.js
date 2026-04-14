// lib/strategy-router.js

// 1. STATIC IMPORTS (Forces Vercel to bundle these files)
import { run as runCoherence } from './strategies/coherence_v1.js';
import { run as runDogeScalper } from './strategies/doge_scalper_v1.js';
import { run as runDogeHfScalper } from './strategies/doge_hf_scalper_v1.js';
import { run as runBtcBreakout } from './strategies/btc_breakout_v1.js';
import { run as runDogeBreakoutScalper } from './strategies/doge_breakout_scalper_v1.js'; 
import { run as runSolRangeReversion } from './strategies/sol_range_reversion_v1.js';
import { run as wldtrendv1 } from './strategies/wld_trend_v1.js';
import { run as keltnerexecution } from './strategies/keltner_execution_v1.js';
import { run as utbotv1 } from './strategies/ut_bot_v1.js';


export async function evaluateStrategy(strategyName, marketData, parameters) {
    try {
        // 2. EXPLICIT ROUTING
        switch (strategyName.toUpperCase()) {
            case 'COHERENCE_V1':
                return await runCoherence(marketData.macro, marketData.trigger, parameters);

            case 'SOL_RANGE_REVERSION_V1':
                return await runSolRangeReversion(marketData.macro, marketData.trigger, parameters);

            case 'UT_BOT_V1':
                return await utbotv1(marketData.macro, marketData.trigger, parameters);

                case 'KELTNER_EXECUTION_V1':
                return await keltnerexecution(marketData.macro, marketData.trigger, parameters);

            case 'WLD_TREND_V1':
                return await wldtrendv1(marketData.macro, marketData.trigger, parameters);
            
            case 'DOGE_SCALPER_V1':
                return await runDogeScalper(marketData.macro, marketData.trigger, parameters);
            
            case 'DOGE_HF_SCALPER_V1':
                return await runDogeHfScalper(marketData.macro, marketData.trigger, parameters);

            case 'BTC_BREAKOUT_V1':
                return await runBtcBreakout(marketData.macro, marketData.trigger, parameters);

            case 'DOGE_BREAKOUT_SCALPER_V1':
                return await runDogeBreakoutScalper(marketData.macro, marketData.trigger, parameters);
            
            default:
                console.error(`[ROUTER ERROR] Strategy ${strategyName} is not mapped in strategy-router.js`);
                return { signal: null, error: "LOGIC_FILE_NOT_MAPPED_OR_FAILED" };
        }

    } catch (error) {
        // If a strategy file has a syntax error, it will catch it here and print the real JS error
        console.error(`[ROUTER FATAL] ${strategyName}:`, error.message);
        return { signal: null, error: error.message };
    }
}