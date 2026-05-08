// lib/get-atr-levels-mcp.js
// ATR/AATR Calculator: Computes volatility-adjusted Stop Loss and Take Profit levels
// Implements AATR formula: AATR = ΔPrice / (Average Volume × Period)

/**
 * Calculate True Range for a single candle
 * @param {Object} candle - Current candle {high, low, close, volume}
 * @param {Object} prevCandle - Previous candle {close}
 * @returns {number} True Range value
 */
function calculateTrueRange(candle, prevCandle) {
    if (!prevCandle) {
        return candle.high - candle.low;
    }
    return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevCandle.close),
        Math.abs(candle.low - prevCandle.close)
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
    
    // Get recent candles for AATR calculation
    const recentCandles = candles.slice(-period);
    
    // Calculate average price delta (close - open)
    let totalDelta = 0;
    let totalVolume = 0;
    
    for (let i = 0; i < recentCandles.length; i++) {
        const c = recentCandles[i];
        const openPrice = c.open !== undefined && !isNaN(c.open) ? c.open : c.close;
        const delta = Math.abs(c.close - openPrice);
        totalDelta += delta;
        totalVolume += c.volume || 1; // Prevent division by zero
    }
    
    const avgDelta = totalDelta / recentCandles.length;
    const avgVolume = totalVolume / recentCandles.length;
    
    // AATR = ΔPrice / (Average Volume × Period)
    if (avgVolume === 0) return 0;
    const aatr = avgDelta / (avgVolume * period);
    
    return aatr;
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
 * Main export: Comprehensive ATR/AATR analysis tool
 * Called by agents to dynamically recalculate TP/SL levels
 * @param {Array} triggerCandles - Candles at trigger timeframe
 * @param {string} triggerTimeframe - Trigger timeframe ('5M', '15M', '1H', etc.)
 * @param {Object} options - Optional parameters {regime, macroCandles, sweepLow, targetPrice, side}
 * @returns {Object} Complete ATR analysis {atr, aatr, sl_levels, tp_calculations, recommendation}
 */
export async function getAtrLevels(triggerCandles, triggerTimeframe, options = {}) {
    const { regime = 'TREND', macroCandles = [], sweepLow, targetPrice, side = 'BUY' } = options;
    
    if (!triggerCandles || triggerCandles.length < 2) {
        return {
            error: 'Insufficient candle data',
            atr: 0,
            aatr: 0,
            sl_levels: null,
            tp_calculations: null
        };
    }
    
    try {
        // Calculate core metrics
        const atr = calculateATR(triggerCandles, 14);
        const aatr = calculateAATR(triggerCandles, 14);
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;
        
        // Initialize result object
        const result = {
            timestamp: new Date().toISOString(),
            trigger_timeframe: triggerTimeframe,
            current_price: parseFloat(currentPrice.toFixed(2)),
            regime: regime,
            
            // Core volatility metrics
            atr: parseFloat(atr.toFixed(4)),
            aatr: parseFloat(aatr.toFixed(6)),
            
            // Stop Loss calculations
            sl_levels: sweepLow ? calculateStopLoss(triggerTimeframe, atr, sweepLow, regime) : null,
            
            // Take Profit calculations
            tp_calculations: targetPrice ? calculateTakeProfit(targetPrice, atr, side) : null,
            
            // Helper: Default SL reference from current price
            sl_default_reference: sweepLow || currentPrice,
            
            // Macro context (optional)
            macro_atr: null,
            macro_regime: regime
        };
        
        // If macro candles provided, calculate macro ATR for multi-TF context
        if (macroCandles && macroCandles.length >= 2) {
            result.macro_atr = parseFloat(calculateATR(macroCandles, 14).toFixed(4));
            result.macro_context = 'Available for regime confirmation';
        }
        
        // Recommendation summary
        result.recommendation = {
            description: `${triggerTimeframe} scalp in ${regime} regime`,
            use_case: ['5M', '15M'].includes(triggerTimeframe) 
                ? 'Intraday scalping' 
                : 'Day trading / Swing',
            atr_sensitivity: atr > 2 ? 'HIGH VOLATILITY' : atr > 0.5 ? 'NORMAL' : 'LOW VOLATILITY',
            how_to_use: 'Use sl_levels.recommended for entry, adjust tp_calculations.frontRun for exits'
        };
        
        return result;
        
    } catch (err) {
        console.error('[ATR LEVELS ERROR]', err.message);
        return {
            error: err.message,
            atr: 0,
            aatr: 0,
            sl_levels: null,
            tp_calculations: null
        };
    }
}

export { calculateTrueRange, calculateATR, calculateAATR, calculateStopLoss, calculateTakeProfit };
