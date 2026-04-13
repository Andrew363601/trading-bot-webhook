import { Highest, Lowest } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Setup Parameters - Now perfectly synced with your JSON
    const {
        leverage = 10,
        market_type = 'FUTURES',
        pivot_period = 48,      // This is now dynamic
        sl_percent = 0.0065,    // Matches our v3 'Sweet Spot'
        tp_percent = 0.02       // If you want a fixed TP instead of the Pivot
    } = parameters;

    // 2. MTF Logic: Calculate Pivot on Macro (5m), Trigger on (1m)
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

    // 3. Current Price from Trigger Candles (1m)
    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    let signal = null;

    if (currentPrice < pivot) {
        signal = 'LONG';
    } else if (currentPrice > pivot) {
        signal = 'SHORT';
    }

    const telemetry = { pivot: parseFloat(pivot.toFixed(6)), currentPrice };
    if (!signal) return { signal: null, telemetry };

    // 4. TP/SL Calculation
    // We use the Pivot as the primary TP, but allow tp_percent as a fallback
    const tpPrice = pivot; 
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