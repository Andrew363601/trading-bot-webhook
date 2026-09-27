// lib/strategy-router.js

import { resolveStrategy } from './strategy-resolver.js';
import { compileStrategy, execStrategy } from './strategy-executor.js';

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
import { run as oraclepriceaction } from './strategies/oracle_price_action_v1.js';

// Canonical built-in strategy names (uppercased). Exported so the strategy
// library API can reject library rows that would shadow a built-in, and so
// the resolver can short-circuit without a DB hit.
export const BUILT_IN_STRATEGIES = new Set([
    'COHERENCE_V1',
    'SOL_RANGE_REVERSION_V1',
    'ORACLE_PRICE_ACTION_V1',
    'UT_BOT_V1',
    'KELTNER_EXECUTION_V1',
    'WLD_TREND_V1',
    'DOGE_SCALPER_V1',
    'DOGE_HF_SCALPER_V1',
    'BTC_BREAKOUT_V1',
    'DOGE_BREAKOUT_SCALPER_V1'
]);

// Compile cache for library strategies, keyed `library_id|version`.
// Compile ERRORS are cached too (60s) so a broken strategy is not recompiled
// on every bar.
const COMPILE_TTL_MS = 60_000;
const compileCache = new Map(); // key -> { value, expiresAt }

function compileCacheGet(key) {
    const hit = compileCache.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
        compileCache.delete(key);
        return undefined;
    }
    return hit.value;
}

function compileCacheSet(key, value) {
    compileCache.set(key, { value, expiresAt: Date.now() + COMPILE_TTL_MS });
}

export async function evaluateStrategy(strategyName, marketData, parameters, tenantId = null) {
    try {
        // 2. EXPLICIT ROUTING
        switch (strategyName.trim().toUpperCase()) {
            case 'COHERENCE_V1':
                return await runCoherence(marketData.macro, marketData.trigger, parameters);

            case 'SOL_RANGE_REVERSION_V1':
                return await runSolRangeReversion(marketData.macro, marketData.trigger, parameters);

                case 'ORACLE_PRICE_ACTION_V1':
                    return await oraclepriceaction(marketData.macro, marketData.trigger, parameters);

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
            
            default: {
                // 3. LIBRARY STRATEGIES: resolve tenant-owned / public rows from
                // strategy_library and execute them in the same sandboxed executor
                // the backtester uses (backtest <-> live parity).
                const resolved = await resolveStrategy(strategyName, tenantId);

                if (resolved.source === 'library') {
                    const cacheKey = `${resolved.library_id}|${resolved.version}`;
                    let compiled = compileCacheGet(cacheKey);
                    if (compiled === undefined) {
                        compiled = compileStrategy(resolved.code);
                        compileCacheSet(cacheKey, compiled);
                    }

                    if (!compiled.ok) {
                        console.error(`[ROUTER ERROR] Library strategy ${strategyName} v${resolved.version} failed to compile:`, compiled.errors.join(' | '));
                        return { signal: null, error: 'STRATEGY_COMPILE_FAILED', telemetry: { MARKET_STATE: 'STRATEGY_COMPILE_FAILED' } };
                    }

                    const result = await execStrategy(compiled.runRef, marketData.macro, marketData.trigger, parameters);
                    return result;
                }

                // Loud, never silently null.
                console.error(`[ROUTER ERROR] Strategy ${strategyName} is not mapped in strategy-router.js and not found in strategy_library`);
                return { signal: null, error: "STRATEGY_NOT_FOUND", telemetry: { MARKET_STATE: 'STRATEGY_NOT_FOUND' } };
            }
        }

    } catch (error) {
        // If a strategy file has a syntax error, it will catch it here and print the real JS error
        console.error(`[ROUTER FATAL] ${strategyName}:`, error.message);
        return { signal: null, error: error.message };
    }
}