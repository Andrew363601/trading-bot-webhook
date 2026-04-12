import { EMA } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    const { 
        leverage, 
        breakout_period, 
        volume_threshold_multiplier, 
        fast_ema_period, 
        slow_ema_period, 
        stop_loss_percentage, 
        take_profit_percentage,
        market_type 
    } = parameters;

    // 1. Data Validation
    if (!macroCandles || !triggerCandles || 
        triggerCandles.length < Math.max(breakout_period + 1, slow_ema_period) || 
        macroCandles.length < slow_ema_period) {
        return { signal: null };
    }

    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    const currentVolume = triggerCandles[triggerCandles.length - 1].volume;

    // 2. Macro Trend Math
    const macroCloses = macroCandles.map(c => c.close);
    const macroFastEma = EMA.calculate({ period: fast_ema_period, values: macroCloses });
    const macroSlowEma = EMA.calculate({ period: slow_ema_period, values: macroCloses });

    if (!macroFastEma.length || !macroSlowEma.length) {
        return { signal: null };
    }

    const lastMacroFastEma = macroFastEma[macroFastEma.length - 1];
    const lastMacroSlowEma = macroSlowEma[macroSlowEma.length - 1];

    let signal = null;
    let entryPrice = currentPrice;
    let tpPrice = null;
    let slPrice = null;

    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    let totalVolume = 0;

    // 3. Breakout calculations
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

    // 4. Evaluate Trading Logic
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

    // --- THE TELEMETRY FIX ---
    // Safely calculate the distance to the nearest breakout level so it doesn't crash
    const distanceToHigh = Math.abs(highestHigh - currentPrice);
    const distanceToLow = Math.abs(currentPrice - lowestLow);
    const priceDistanceToLevel = Math.min(distanceToHigh, distanceToLow);

    const currentTelemetry = {
        volume: currentVolume,
        avg_volume: parseFloat(averageVolume.toFixed(2)),
        distance: parseFloat(priceDistanceToLevel.toFixed(4))
    };

    // If there is no trade, exit early but still stream the telemetry!
    if (!signal) {
        return { 
            signal: null, 
            telemetry: currentTelemetry 
        };
    }

    // 5. Return the Standardized Decision Envelope (Trade Fired!)
    return {
        signal: signal,
        entryPrice: entryPrice,
        leverage: leverage || 10,
        marketType: market_type || 'FUTURES',
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry // Pass the exact same telemetry object here
    };
}