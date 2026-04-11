// 1. Add the missing import
import { EMA } from 'technicalindicators';

// 2. Add the missing 'export' keyword
export async function run(macroCandles, triggerCandles, parameters) {
    const { leverage, breakout_period, volume_threshold_multiplier, fast_ema_period, slow_ema_period, stop_loss_percentage, take_profit_percentage } = parameters;

    if (triggerCandles.length < Math.max(breakout_period + 1, slow_ema_period) || macroCandles.length < slow_ema_period) {
        return { signal: null };
    }

    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    const currentVolume = triggerCandles[triggerCandles.length - 1].volume;

    // 3. Fix the EMA call to use the imported module directly
    const macroCloses = macroCandles.map(c => c.close);
    const macroFastEma = EMA.calculate({ period: fast_ema_period, values: macroCloses });
    const macroSlowEma = EMA.calculate({ period: slow_ema_period, values: macroCloses });

    const lastMacroFastEma = macroFastEma[macroFastEma.length - 1];
    const lastMacroSlowEma = macroSlowEma[macroSlowEma.length - 1];

    let signal = null;
    let entryPrice = currentPrice;
    let tpPrice = null;
    let slPrice = null;

    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    let totalVolume = 0;

    for (let i = triggerCandles.length - 1 - breakout_period; i < triggerCandles.length - 1; i++) {
        if (triggerCandles[i].high > highestHigh) {
            highestHigh = triggerCandles[i].high;
        }
        if (triggerCandles[i].low < lowestLow) {
            lowestLow = triggerCandles[i].low;
        }
        totalVolume += triggerCandles[i].volume;
    }
    const averageVolume = totalVolume / breakout_period;

    if (lastMacroFastEma > lastMacroSlowEma && 
        currentPrice > highestHigh && 
        currentVolume > averageVolume * volume_threshold_multiplier) { 
        
        signal = 'LONG';
        slPrice = entryPrice * (1 - stop_loss_percentage);
        tpPrice = entryPrice * (1 + take_profit_percentage);

    } else if (lastMacroFastEma < lastMacroSlowEma && 
               currentPrice < lowestLow && 
               currentVolume > averageVolume * volume_threshold_multiplier) { 
        
        signal = 'SHORT';
        slPrice = entryPrice * (1 + stop_loss_percentage);
        tpPrice = entryPrice * (1 - take_profit_percentage);
    }

    return {
        signal,
        entryPrice,
        leverage,
        marketType: 'SPOT',
        tpPrice,
        slPrice,
        telemetry: { 
            volume: currentVolume, 
            distance: priceDistanceToLevel 
        }
    };
}