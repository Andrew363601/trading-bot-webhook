import { EMA, RSI } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Extract parameters with safe fallbacks
    const {
        fast_ema_period = 10,
        slow_ema_period = 20,
        rsi_period = 14,
        rsi_oversold = 30,
        rsi_overbought = 70,
        macro_ema_period = 20,
        crossover_lookback = 3, // New parameter to fix the condition race
        leverage = 10,
        market_type = 'FUTURES',
        tp_percent = 0.002,
        sl_percent = 0.001
    } = parameters;

    // 2. Format Data arrays
    const triggerCloses = triggerCandles ? triggerCandles.map(c => c.close) : [];
    const macroCloses = macroCandles ? macroCandles.map(c => c.close) : [];

    // 3. Safety check for enough data
    const maxPeriod = Math.max(fast_ema_period, slow_ema_period, rsi_period);
    if (triggerCloses.length < maxPeriod + crossover_lookback + 1 || macroCloses.length < macro_ema_period + 2) {
        return { signal: null };
    }

    // 4. Calculate Indicators
    const fastEMA = EMA.calculate({ period: fast_ema_period, values: triggerCloses });
    const slowEMA = EMA.calculate({ period: slow_ema_period, values: triggerCloses });
    const rsi = RSI.calculate({ period: rsi_period, values: triggerCloses });
    const macroEMA = EMA.calculate({ period: macro_ema_period, values: macroCloses });

    if (!fastEMA.length || !slowEMA.length || !rsi.length || !macroEMA.length) {
        return { signal: null };
    }

    // 5. Extract current values
    const currentFastEMA = fastEMA[fastEMA.length - 1];
    const currentSlowEMA = slowEMA[slowEMA.length - 1];
    const currentRSI = rsi[rsi.length - 1];
    const currentMacroEMA = macroEMA[macroEMA.length - 1];
    const previousMacroEMA = macroEMA[macroEMA.length - 2];
    const currentPrice = triggerCloses[triggerCloses.length - 1];

    // 6. Evaluate Crossover Lookback Window
    let recentLongCross = false;
    let recentShortCross = false;

    for (let i = 0; i < crossover_lookback; i++) {
        const idx = fastEMA.length - 1 - i;
        const prevIdx = idx - 1;
        
        if (prevIdx >= 0) {
            if (fastEMA[prevIdx] <= slowEMA[prevIdx] && fastEMA[idx] > slowEMA[idx]) {
                recentLongCross = true;
            }
            if (fastEMA[prevIdx] >= slowEMA[prevIdx] && fastEMA[idx] < slowEMA[idx]) {
                recentShortCross = true;
            }
        }
    }

    let signal = null;

    // 7. Evaluate Trading Logic (Condition Race Fixed)
    if (
        recentLongCross && 
        currentFastEMA > currentSlowEMA && 
        currentRSI < rsi_overbought && 
        currentMacroEMA > previousMacroEMA
    ) {
        signal = 'LONG';
    } else if (
        recentShortCross && 
        currentFastEMA < currentSlowEMA && 
        currentRSI > rsi_oversold && 
        currentMacroEMA < previousMacroEMA
    ) {
        signal = 'SHORT';
    }

    // 8. THE TELEMETRY FIX (MANDATORY)
    const currentTelemetry = {
        rsi: parseFloat(currentRSI.toFixed(2)),
        fast_ema: parseFloat(currentFastEMA.toFixed(4)),
        slow_ema: parseFloat(currentSlowEMA.toFixed(4)),
        macro_ema_trend: currentMacroEMA > previousMacroEMA ? 'UP' : 'DOWN'
    };

    // 9. EARLY EXIT
    if (!signal) {
        return { signal: null, telemetry: currentTelemetry };
    }

    // 10. DYNAMIC EXITS
    const tpPrice = signal === 'LONG' ? currentPrice * (1 + tp_percent) : currentPrice * (1 - tp_percent);
    const slPrice = signal === 'LONG' ? currentPrice * (1 - sl_percent) : currentPrice * (1 + sl_percent);

    // 11. STANDARDIZED DECISION ENVELOPE
    return {
        signal: signal,
        entryPrice: currentPrice,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry
    };
}