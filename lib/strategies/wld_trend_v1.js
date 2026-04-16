import { EMA } from 'technicalindicators';

function getPivot(candles, period) {
    if (candles.length < period) return null;
    const relevantCandles = candles.slice(-period);
    let typicalPriceSum = 0;
    
    for (const c of relevantCandles) {
        typicalPriceSum += (c.high + c.low + c.close) / 3;
    }
    return typicalPriceSum / period;
}

export async function run(macroCandles, triggerCandles, parameters) {
    const { 
        leverage = 10, 
        market_type = 'FUTURES', 
        tp_percent = 0.05, 
        sl_percent = 0.0045, 
        pivot_period = 96, 
        ema_period = 50 
    } = parameters;

    if (!macroCandles || !triggerCandles || triggerCandles.length < Math.max(pivot_period, ema_period)) {
        return { signal: null };
    }

    let signal = null;
    const entryPrice = triggerCandles[triggerCandles.length - 1].close;
    
    const pivot = getPivot(triggerCandles, pivot_period);
    const triggerCloses = triggerCandles.map(c => c.close);
    const ema50 = EMA.calculate({ period: ema_period, values: triggerCloses }).slice(-1)[0];

    if (!pivot || !ema50) {
        return { signal: null, telemetry: { pivot: pivot, ema50: ema50 } };
    }

    // Original mean-reversion logic
    if (entryPrice > pivot) {
        signal = 'SHORT';
    } else if (entryPrice < pivot) {
        signal = 'LONG';
    }

    // --- NEW MOMENTUM FILTER ---
    // A long is only valid if the price is above the 50 EMA.
    if (signal === 'LONG' && entryPrice < ema50) {
        signal = null;
    }
    // A short is only valid if the price is below the 50 EMA.
    if (signal === 'SHORT' && entryPrice > ema50) {
        signal = null;
    }
    // --- END FILTER ---

    const currentTelemetry = { pivot: pivot, ema50: ema50 };
    if (!signal) return { signal: null, telemetry: currentTelemetry };

    const tpPrice = signal === 'LONG' ? entryPrice * (1 + tp_percent) : entryPrice * (1 - tp_percent);
    const slPrice = signal === 'LONG' ? entryPrice * (1 - sl_percent) : entryPrice * (1 + sl_percent);

    return {
        signal: signal,
        entryPrice: entryPrice,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry
    };
}