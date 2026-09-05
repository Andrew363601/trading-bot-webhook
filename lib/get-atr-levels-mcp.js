// lib/get-atr-levels-mcp.js
// ATR/AATR Calculator: Computes volatility-adjusted Stop Loss and Take Profit levels
// Implements AATR formula: AATR = ΔPrice / (Average Volume × Period)
//
// FIX 38: candles are fetched SERVER-SIDE at the strategy's configured
// trigger/macro timeframes (Coinbase granularity vocabulary, same canon as
// execute-trade-mcp FIX 25 / get-market-state). Agents never pass candles
// inline anymore — the legacy inline path survives only as a validated
// fallback with loud diagnostics on malformed input.

import { fetchCoinbaseData } from './get-market-state-mcp.js';

/**
 * Normalize a timeframe label to the short form used by the SL tier logic.
 * Accepts Coinbase granularity strings (FIVE_MINUTE, FIFTEEN_MINUTE, ...) and
 * the legacy short labels ('5M', '15M') which pass through unchanged.
 */
function normalizeTimeframe(tf) {
    if (!tf || typeof tf !== 'string') return '1H';
    const t = tf.toUpperCase().trim();
    const map = {
        'ONE_MINUTE': '1M',
        'FIVE_MINUTE': '5M',
        'FIFTEEN_MINUTE': '15M',
        'THIRTY_MINUTE': '30M',
        'ONE_HOUR': '1H',
        'TWO_HOUR': '2H',
        'SIX_HOUR': '6H',
        'ONE_DAY': '1D'
    };
    return map[t] || t;
}

/**
 * Validate/coerce a single candle. Coerces o/h/l/c/v via Number(); throws a
 * LOUD error naming the index and the candle's actual keys if a numeric
 * close cannot be produced. Never let a bare TypeError escape.
 */
function coerceCandle(candle, index) {
    if (!candle || typeof candle !== 'object' || Array.isArray(candle)) {
        throw new Error(`candle[${index}] is not an object (got ${candle === null ? 'null' : typeof candle})`);
    }
    const coerced = {
        t: candle.t,
        o: Number(candle.o !== undefined ? candle.o : candle.open),
        h: Number(candle.h !== undefined ? candle.h : candle.high),
        l: Number(candle.l !== undefined ? candle.l : candle.low),
        c: Number(candle.c !== undefined ? candle.c : candle.close),
        v: Number(candle.v !== undefined ? candle.v : candle.volume)
    };
    if (!Number.isFinite(coerced.c)) {
        throw new Error(`candle[${index}] missing close; keys: ${Object.keys(candle).join(',')}`);
    }
    return coerced;
}

/**
 * Validate/coerce a full candle array (legacy inline path only).
 */
function coerceCandleArray(candles) {
    return candles.map(coerceCandle);
}

/**
 * Calculate True Range for a single candle
 * @param {Object} candle - Current candle {high, low, close, volume}
 * @param {Object} prevCandle - Previous candle {close}
 * @returns {number} True Range value
 */
function calculateTrueRange(candle, prevCandle) {
    if (!prevCandle) {
        return candle.h - candle.l;
    }
    return Math.max(
        candle.h - candle.l,
        Math.abs(candle.h - prevCandle.c),
        Math.abs(candle.l - prevCandle.c)
    );
}

/**
 * Calculate standard Average True Range (14-period by default)
 * @param {Array} candles - Array of candle objects [{high, low, close, volume}, ...]
 * @param {number} period - ATR period (default: 14)
 * @returns {number} ATR value
 */
function calculateATR(candles, period = 14) {
    if (!candles || candles.length < 2) return 0;
    
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = calculateTrueRange(candles[i], candles[i - 1]);
        trueRanges.push(tr);
    }
    
    if (trueRanges.length === 0) return 0;
    
    const recentTR = trueRanges.slice(-period);
    const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / Math.min(period, recentTR.length);
    return atr;
}

/**
 * Calculate Adjusted Average True Range (AATR)
 * Formula: AATR = ΔPrice / (Average Volume × Period)
 * @param {Array} candles - Array of candle objects [{high, low, close, volume, open}, ...]
 * @param {number} period - Period for calculation (default: 14)
 * @returns {number} AATR value (volume-normalized volatility)
 */
function calculateAATR(candles, period = 14) {
    if (!candles || candles.length < period) return 0;

    const recentCandles = candles.slice(-period);

    let totalDelta = 0;
    let totalVolume = 0;

    for (let i = 0; i < recentCandles.length; i++) {
        const c = recentCandles[i];
        const openPrice = Number.isFinite(c.o) ? c.o : c.c;
        const delta = Math.abs(c.c - openPrice);
        totalDelta += delta;
        totalVolume += Number.isFinite(c.v) && c.v > 0 ? c.v : 1; // Prevent division by zero
    }

    const avgDelta = totalDelta / recentCandles.length;
    const avgVolume = totalVolume / recentCandles.length;

    if (avgVolume === 0) return 0;
    return avgDelta / (avgVolume * period);
}

/**
 * Calculate Stop Loss level based on timeframe and regime
 * Per SKILL.md:
 * - Scalping (5M/15M): 1.5x - 2.0x ATR below sweep low
 * - Day Trading (1H+): 2.0x - 2.5x ATR below support
 * @param {string} timeframe - Trigger timeframe ('5M', '15M', '1H', etc.)
 * @param {number} atr - Current ATR value
 * @param {number} referencePrice - Sweep low or support price
 * @param {string} regime - Market regime ('TREND' or 'CHOP')
 * @returns {Object} SL levels {aggressive, conservative, recommended}
 */
function calculateStopLoss(timeframe, atr, referencePrice, regime = 'TREND') {
    const isScalping = ['5M', '15M'].includes(timeframe);
    
    if (isScalping) {
        // Scalping: 1.5x - 2.0x ATR
        const aggressive = referencePrice - (atr * 1.5);
        const conservative = referencePrice - (atr * 2.0);
        
        // In TREND regime, be more aggressive; in CHOP, be more conservative
        const recommended = regime === 'TREND' ? aggressive : conservative;
        
        return {
            aggressive: parseFloat(aggressive.toFixed(2)),
            conservative: parseFloat(conservative.toFixed(2)),
            recommended: parseFloat(recommended.toFixed(2)),
            multiplier: regime === 'TREND' ? 1.5 : 2.0,
            tier: 'scalping'
        };
    } else {
        // Day Trading (1H+): 2.0x - 2.5x ATR
        const aggressive = referencePrice - (atr * 2.0);
        const conservative = referencePrice - (atr * 2.5);
        
        // In TREND regime, be more aggressive; in CHOP, be more conservative
        const recommended = regime === 'TREND' ? aggressive : conservative;
        
        return {
            aggressive: parseFloat(aggressive.toFixed(2)),
            conservative: parseFloat(conservative.toFixed(2)),
            recommended: parseFloat(recommended.toFixed(2)),
            multiplier: regime === 'TREND' ? 2.0 : 2.5,
            tier: 'day_trading'
        };
    }
}

/**
 * Calculate Take Profit offset
 * Per SKILL.md: Front-run the target by 50% of the current ATR
 * @param {number} targetPrice - TP target price
 * @param {number} atr - Current ATR value
 * @param {string} side - 'BUY' or 'SELL'
 * @returns {Object} TP calculations {frontRun, exact, offset}
 */
function calculateTakeProfit(targetPrice, atr, side = 'BUY') {
    const offset = atr * 0.5; // 50% ATR buffer
    
    // For longs (BUY), front-run by moving TP down; for shorts (SELL), move TP up
    const frontRunPrice = side === 'BUY' ? targetPrice - offset : targetPrice + offset;
    
    return {
        exact: parseFloat(targetPrice.toFixed(2)),
        frontRun: parseFloat(frontRunPrice.toFixed(2)),
        offset: parseFloat(offset.toFixed(2)),
        side: side,
        rule: '50% ATR front-run buffer per SKILL.md'
    };
}

/**
 * Main export: Comprehensive ATR/AATR analysis tool (FIX 38)
 * Candles are fetched SERVER-SIDE at the strategy's configured timeframes so
 * ATR always reflects the granularity the trade actually lives in.
 * @param {Object} args - {symbol, triggerTimeframe, macroTimeframe, regime,
 *   sweepLow, targetPrice, side, apiKey, apiSecret, [legacy: triggerCandles, macroCandles]}
 * @returns {Object} Complete ATR analysis {atr, aatr, sl_levels, tp_calculations, recommendation}
 */
export async function getAtrLevels(args = {}) {
    const {
        symbol,
        regime = 'TREND',
        sweepLow,
        targetPrice,
        side = 'BUY',
        apiKey = process.env.COINBASE_API_KEY,
        apiSecret = process.env.COINBASE_API_SECRET,
        // Legacy inline fallbacks (validated loudly below)
        triggerCandles: legacyTriggerCandles,
        macroCandles: legacyMacroCandles
    } = args;

    const triggerTimeframe = args.triggerTimeframe || args.trigger_tf || 'FIVE_MINUTE';
    const macroTimeframe = args.macroTimeframe || args.macro_tf || 'ONE_HOUR';
    const normalizedTf = normalizeTimeframe(triggerTimeframe);

    try {
        let triggerCandles;
        let macroCandles = [];

        if (Array.isArray(legacyTriggerCandles) && legacyTriggerCandles.length > 0) {
            // ── LEGACY PATH: inline candles, validated loudly ──
            triggerCandles = coerceCandleArray(legacyTriggerCandles);
            if (Array.isArray(legacyMacroCandles) && legacyMacroCandles.length > 0) {
                macroCandles = coerceCandleArray(legacyMacroCandles);
            }
        } else {
            // ── SERVER-SIDE FETCH at the strategy's configured granularity ──
            if (!symbol) return ERROR_SHAPE('symbol is required (e.g. ETH-PERP-INTX)');
            const [tCandles, mCandles] = await Promise.all([
                fetchCoinbaseData(symbol, triggerTimeframe, apiKey, apiSecret),
                fetchCoinbaseData(symbol, macroTimeframe, apiKey, apiSecret).catch(() => [])
            ]);
            if (!tCandles || tCandles.length < 2) {
                return ERROR_SHAPE(
                    `Failed to fetch ${triggerTimeframe} candles for ${symbol} server-side. Never fall back to a different timeframe — re-check symbol/granularity.`
                );
            }
            triggerCandles = tCandles.map(coerceCandle);
            macroCandles = (mCandles || []).map(coerceCandle);
        }

        if (triggerCandles.length < 2) {
            return ERROR_SHAPE('Insufficient candle data (need >= 2 candles)');
        }

        // Calculate core metrics
        const atr = calculateATR(triggerCandles, 14);
        const aatr = calculateAATR(triggerCandles, 14);

        // current_price guard: last close ?? null with explicit error if unfixable
        const lastCandle = triggerCandles[triggerCandles.length - 1];
        const currentPrice = Number.isFinite(lastCandle.c) ? lastCandle.c : null;
        if (currentPrice === null || !Number.isFinite(currentPrice)) {
            return ERROR_SHAPE('current_price unresolvable: last trigger candle has no numeric close');
        }

        const result = {
            timestamp: new Date().toISOString(),
            trigger_timeframe: normalizedTf,
            macro_timeframe: normalizeTimeframe(macroTimeframe),
            current_price: parseFloat(currentPrice.toFixed(2)),
            regime: regime,

            atr: parseFloat(atr.toFixed(4)),
            aatr: parseFloat(aatr.toFixed(6)),

            sl_levels: sweepLow ? calculateStopLoss(normalizedTf, atr, sweepLow, regime) : null,
            tp_calculations: targetPrice ? calculateTakeProfit(targetPrice, atr, side) : null,

            sl_default_reference: sweepLow || currentPrice,

            macro_atr: null,
            macro_regime: regime
        };

        if (macroCandles && macroCandles.length >= 2) {
            result.macro_atr = parseFloat(calculateATR(macroCandles, 14).toFixed(4));
            result.macro_context = 'Available for regime confirmation';
        }

        // Recommendation summary (uses NORMALIZED tf so scalping tier + label agree)
        result.recommendation = {
            description: `${normalizedTf} scalp in ${regime} regime`,
            use_case: ['5M', '15M'].includes(normalizedTf)
                ? 'Intraday scalping'
                : 'Day trading / Swing',
            atr_sensitivity: atr > 2 ? 'HIGH VOLATILITY' : atr > 0.5 ? 'NORMAL' : 'LOW VOLATILITY',
            how_to_use: 'Use sl_levels.recommended for entry, adjust tp_calculations.frontRun for exits'
        };

        return result;

    } catch (err) {
        console.error('[ATR LEVELS ERROR]', err.message);
        return ERROR_SHAPE(err.message);
    }
}

export { calculateTrueRange, calculateATR, calculateAATR, calculateStopLoss, calculateTakeProfit };

const ERROR_SHAPE = (message) => ({
    error: message,
    atr: 0,
    aatr: 0,
    sl_levels: null,
    tp_calculations: null
});
