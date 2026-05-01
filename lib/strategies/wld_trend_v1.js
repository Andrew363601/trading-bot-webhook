// lib/strategies/wld_trend_v1.js
import { EMA } from 'technicalindicators';

function getPivot(candles, period) {
    if (!candles || candles.length < period) return null;
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

    const candleCount = triggerCandles ? triggerCandles.length : 0;
    const requiredCandles = Math.max(pivot_period, ema_period);

    // 1. ALWAYS INITIALIZE TELEMETRY FIRST
    // This ensures your UI always has data to display, even if the market is dead.
    let currentTelemetry = {
        CANDLE_COUNT: candleCount,
        REQUIRED_CANDLES: requiredCandles,
        MARKET_STATE: 'ANALYZING'
    };

    // 2. THE LOW VOLUME TRAP FIX
    if (!macroCandles || !triggerCandles || candleCount < requiredCandles) {
        currentTelemetry.MARKET_STATE = 'INSUFFICIENT_DATA (LOW VOL)';
        return { signal: null, telemetry: currentTelemetry };
    }

    let signal = null;
    const entryPrice = triggerCandles[triggerCandles.length - 1].close;
    
    const pivot = getPivot(triggerCandles, pivot_period);
    const triggerCloses = triggerCandles.map(c => c.close);
    
    let ema50 = null;
    try {
        const emaArray = EMA.calculate({ period: ema_period, values: triggerCloses });
        if (emaArray && emaArray.length > 0) ema50 = emaArray[emaArray.length - 1];
    } catch(e) {
        console.error("EMA Math Error");
    }

    // Add the indicators to telemetry so you can see them on the frontend
    currentTelemetry.PIVOT_POINT = pivot ? parseFloat(pivot.toFixed(4)) : 'ERR';
    currentTelemetry.EMA_50 = ema50 ? parseFloat(ema50.toFixed(4)) : 'ERR';
    currentTelemetry.CURRENT_PRICE = entryPrice;

    if (!pivot || !ema50) {
        currentTelemetry.MARKET_STATE = 'INDICATOR_FAULT';
        return { signal: null, telemetry: currentTelemetry };
    }

    // 🟢 THE UPGRADE: Pure Mean-Reversion. The EMA blindfold is gone.
    // It will now short the ceiling and buy the floor, leaving validation to the AI.
    if (entryPrice > pivot) {
        signal = 'SHORT';
    } else if (entryPrice < pivot) {
        signal = 'LONG';
    }

    if (signal) {
        currentTelemetry.MARKET_STATE = `RESONANT (${signal})`;
    } else {
        currentTelemetry.MARKET_STATE = 'CHOP';
    }

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