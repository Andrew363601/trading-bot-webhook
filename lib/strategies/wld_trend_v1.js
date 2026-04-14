import { Highest, Lowest } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Setup Parameters - Synced with your JSON
    const {
        leverage = 10,
        market_type = 'FUTURES',
        pivot_period = 48,      
        sl_percent = 0.0035,    
        tp_percent = 0.05       
    } = parameters;

    // 2. MTF Logic: Calculate Pivot on Macro, Trigger on Trigger
    if (!macroCandles || macroCandles.length < pivot_period + 1) {
        return { signal: null, telemetry: { error: 'Insufficient Macro history' } };
    }

    const lookback = macroCandles.slice(-(pivot_period + 1), -1);
    const highValues = lookback.map(c => c.high);
    const lowValues = lookback.map(c => c.low);
    const prevClose = lookback[lookback.length - 1].close;

    const highestHigh = Math.max(...highValues);
    const lowestLow = Math.min(...lowValues);
    const pivot = (highestHigh + lowestLow + prevClose) / 3;

    // 3. Current Price from Trigger Candles
    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    let signal = null;

    // MINIMUM MOVE FILTER: Ensure the TP is far enough away to justify the trade risk.
    // We require the Pivot to be at least 0.2% away from the current price.
    const distanceToPivot = Math.abs(pivot - currentPrice);
    const minMoveRequired = currentPrice * 0.002; 

    if (currentPrice < pivot && distanceToPivot > minMoveRequired) {
        signal = 'LONG';
    } else if (currentPrice > pivot && distanceToPivot > minMoveRequired) {
        signal = 'SHORT';
    }

    // Pass the pivot down as 2 decimals for clean telemetry
    const telemetry = { 
        pivot: parseFloat(pivot.toFixed(2)), 
        currentPrice: currentPrice,
        targetDistance: parseFloat(distanceToPivot.toFixed(2))
    };
    
    if (!signal) return { signal: null, telemetry };

    // 4. TP/SL Calculation
    // Using the Pivot as the primary TP, Stop Loss based on the percentage
    const tpPrice = pivot; 
    const slPrice = signal === 'LONG' 
        ? currentPrice * (1 - sl_percent) 
        : currentPrice * (1 + sl_percent);

    return {
        signal: signal,
        entryPrice: currentPrice,
        leverage: leverage,
        marketType: market_type,
        // THE FIX: Strict 2-decimal formatting for Coinbase API
        tpPrice: parseFloat(tpPrice.toFixed(2)),
        slPrice: parseFloat(slPrice.toFixed(2)),
        telemetry: telemetry
    };
}