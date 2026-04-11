import { EMA, RSI } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Extract parameters with safe fallbacks
    const fast_ema_period = parameters?.fast_ema_period || 10;
    const slow_ema_period = parameters?.slow_ema_period || 20;
    const rsi_period = parameters?.rsi_period || 14;
    const rsi_oversold = parameters?.rsi_oversold || 30;
    const rsi_overbought = parameters?.rsi_overbought || 70;
    
    // Defaulting macro EMA to 20 if not explicitly set in the database
    const macro_ema_period = parameters?.macro_ema_period || 20;

    const leverage = parameters?.leverage || 10;
    const marketType = parameters?.market_type || 'SPOT';
    const tpPercent = parameters?.take_profit_percentage || parameters?.tp_percent || 0.002;
    const slPercent = parameters?.stop_loss_percentage || parameters?.sl_percent || 0.001;

    // 2. Format Data arrays
    const triggerCloses = triggerCandles ? triggerCandles.map(c => c.close) : [];
    const macroCloses = macroCandles ? macroCandles.map(c => c.close) : [];

    // 3. Safety check for enough data
    const maxPeriod = Math.max(fast_ema_period, slow_ema_period, rsi_period);
    if (triggerCloses.length < maxPeriod + 2 || macroCloses.length < macro_ema_period + 2) {
        return { signal: null };
    }

    // 4. Calculate Indicators
    const fastEMA = EMA.calculate({ period: fast_ema_period, values: triggerCloses });
    const slowEMA = EMA.calculate({ period: slow_ema_period, values: triggerCloses });
    const rsi = RSI.calculate({ period: rsi_period, values: triggerCloses });
    const macroEMA = EMA.calculate({ period: macro_ema_period, values: macroCloses });

    // Ensure indicator arrays are populated
    if (!fastEMA.length || !slowEMA.length || !rsi.length || !macroEMA.length) {
        return { signal: null };
    }

    // 5. Extract current and previous timeframe values
    const currentFastEMA = fastEMA[fastEMA.length - 1];
    const previousFastEMA = fastEMA[fastEMA.length - 2];
    
    const currentSlowEMA = slowEMA[slowEMA.length - 1];
    const previousSlowEMA = slowEMA[slowEMA.length - 2];
    
    const currentRSI = rsi[rsi.length - 1];
    
    const currentMacroEMA = macroEMA[macroEMA.length - 1];
    const previousMacroEMA = macroEMA[macroEMA.length - 2];
    
    const currentPrice = triggerCloses[triggerCloses.length - 1];

    let signal = null;

    // 6. Evaluate Trading Logic
    // LONG: Fast crosses over Slow, RSI has room to grow, Macro trend is UP
    if (
        previousFastEMA <= previousSlowEMA && 
        currentFastEMA > currentSlowEMA && 
        currentRSI < rsi_overbought && 
        currentMacroEMA > previousMacroEMA
    ) {
        signal = 'LONG';
    } 
    // SHORT: Fast crosses under Slow, RSI isn't oversold yet, Macro trend is DOWN
    else if (
        previousFastEMA >= previousSlowEMA && 
        currentFastEMA < currentSlowEMA && 
        currentRSI > rsi_oversold && 
        currentMacroEMA < previousMacroEMA
    ) {
        signal = 'SHORT';
    }

    // If conditions aren't met, return a stable scan with the RSI value
    if (!signal) return { signal: null, mci: currentRSI };

    // 7. Calculate Exits
    const tpPrice = signal === 'LONG' 
        ? currentPrice * (1 + tpPercent) 
        : currentPrice * (1 - tpPercent);
        
    const slPrice = signal === 'LONG' 
        ? currentPrice * (1 - slPercent) 
        : currentPrice * (1 + slPercent);

    // 8. Return the Standardized Decision Envelope
    return {
        signal: signal,
        entryPrice: currentPrice,
        mci: currentRSI, // Hijacking the MCI variable to display RSI on the UI
        leverage: leverage,
        marketType: marketType,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6))
    };
}