import { EMA } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    const { 
        leverage, 
        breakout_period, 
        volume_period, 
        volume_threshold_multiplier, 
        fast_ema_period, 
        slow_ema_period, 
        stop_loss_percentage, 
        take_profit_percentage 
    } = parameters;

    // 1. Data Validation: Ensure we have enough candles to run the math
    if (
        macroCandles.length < Math.max(fast_ema_period, slow_ema_period) || 
        triggerCandles.length < Math.max(breakout_period + 1, volume_period + 1)
    ) {
        return { signal: null };
    }

    // 2. Macro trend confirmation (5-minute)
    const macroCloses = macroCandles.map(c => c.close);
    const macroFastEma = EMA.calculate({ period: fast_ema_period, values: macroCloses });
    const macroSlowEma = EMA.calculate({ period: slow_ema_period, values: macroCloses });

    const currentMacroFastEma = macroFastEma[macroFastEma.length - 1];
    const currentMacroSlowEma = macroSlowEma[macroSlowEma.length - 1];

    const isBullishMacroTrend = currentMacroFastEma > currentMacroSlowEma;
    const isBearishMacroTrend = currentMacroFastEma < currentMacroSlowEma;

    // 3. Trigger timeframe (1-minute) variables
    const triggerCloses = triggerCandles.map(c => c.close);
    const triggerHighs = triggerCandles.map(c => c.high);
    const triggerLows = triggerCandles.map(c => c.low);
    const triggerVolumes = triggerCandles.map(c => c.volume);

    const currentTriggerClose = triggerCloses[triggerCloses.length - 1];
    const currentTriggerVolume = triggerVolumes[triggerVolumes.length - 1];

    // 4. Calculate highest high and lowest low for breakout period (excluding current candle)
    let highestHighBreakout = 0;
    let lowestLowBreakout = Infinity;
    
    for (let i = 1; i <= breakout_period; i++) {
        const lookbackIndex = triggerHighs.length - 1 - i;
        
        if (triggerHighs[lookbackIndex] > highestHighBreakout) {
            highestHighBreakout = triggerHighs[lookbackIndex];
        }
        
        if (triggerLows[lookbackIndex] < lowestLowBreakout) {
            lowestLowBreakout = triggerLows[lookbackIndex];
        }
    }

    // 5. Calculate average volume for volume threshold
    let sumVolume = 0;
    for (let i = 1; i <= volume_period; i++) {
        sumVolume += triggerVolumes[triggerVolumes.length - 1 - i];
    }
    const averageVolume = sumVolume / volume_period;
    const volumeThreshold = averageVolume * volume_threshold_multiplier;

    const isVolumeSurge = currentTriggerVolume > volumeThreshold;

    let signal = null;
    let entryPrice = currentTriggerClose;
    let tpPrice = null;
    let slPrice = null;

    // 6. Breakout Conditions
    if (isBullishMacroTrend && currentTriggerClose > highestHighBreakout && isVolumeSurge) {
        signal = 'LONG';
        tpPrice = entryPrice * (1 + take_profit_percentage);
        slPrice = entryPrice * (1 - stop_loss_percentage);
    } 
    else if (isBearishMacroTrend && currentTriggerClose < lowestLowBreakout && isVolumeSurge) {
        signal = 'SHORT';
        tpPrice = entryPrice * (1 - take_profit_percentage);
        slPrice = entryPrice * (1 + stop_loss_percentage);
    }

    // 7. Return payload to the router
    return {
        signal,
        entryPrice,
        leverage,
        marketType: 'FUTURES',
        tpPrice,
        slPrice
    };
}