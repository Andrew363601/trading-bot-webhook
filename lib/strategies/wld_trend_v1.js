import { Highest, Lowest } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Setup Parameters (v3 Sweet Spot Defaults)
    const {
        leverage = 10,
        market_type = 'FUTURES',
        pivot_period = 48,
        sl_percent = 0.0065 // 0.65% from our v3 optimization
    } = parameters;

    // Use triggerCandles (3m or 5m) as the source of truth
    const candles = triggerCandles;

    // Ensure we have enough history to calculate the 48-period lookback
    if (!candles || candles.length < pivot_period + 1) {
        return { signal: null, telemetry: { error: 'Insufficient candle history' } };
    }

    // 2. Pivot Calculation Logic
    // We slice the candles to get the PREVIOUS 48, excluding the current active candle
    const lookback = candles.slice(-(pivot_period + 1), -1);
    const highValues = lookback.map(c => c.high);
    const lowValues = lookback.map(c => c.low);
    const prevClose = lookback[lookback.length - 1].close;

    const highestHigh = Math.max(...highValues);
    const lowestLow = Math.min(...lowValues);
    const pivot = (highestHigh + lowestLow + prevClose) / 3;

    // 3. Signal Generation
    const currentPrice = candles[candles.length - 1].close;
    let signal = null;

    if (currentPrice < pivot) {
        signal = 'LONG';
    } else if (currentPrice > pivot) {
        signal = 'SHORT';
    }

    const telemetry = { pivot: parseFloat(pivot.toFixed(6)), currentPrice };

    if (!signal) return { signal: null, telemetry };

    // 4. TP/SL Calculation
    // For Mean Reversion, the Pivot IS the Take Profit target.
    const tpPrice = pivot; 
    
    // Calculate Stop Loss based on the 0.65% Sweet Spot
    const slPrice = signal === 'LONG' 
        ? currentPrice * (1 - sl_percent) 
        : currentPrice * (1 + sl_percent);

    return {
        signal: signal,
        entryPrice: currentPrice,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: telemetry
    };
}