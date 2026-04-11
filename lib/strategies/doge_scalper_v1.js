import { EMA, VWAP } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Extract parameters with safe fallbacks
    const fast_ema_period = parameters?.fast_ema_period || 9;
    const slow_ema_period = parameters?.slow_ema_period || 21;
    const vwap_period = parameters?.vwap_period || 14;
    const volume_threshold = parameters?.volume_threshold || 1000;
    
    const leverage = parameters?.leverage || 1;
    const marketType = parameters?.market_type || 'SPOT';
    const tpPercent = parameters?.take_profit_percentage || parameters?.tp_percent || 0.02;
    const slPercent = parameters?.stop_loss_percentage || parameters?.sl_percent || 0.01;

    // Safety check for enough data
    if (!triggerCandles || triggerCandles.length < slow_ema_period) {
        return { signal: null };
    }

    // 2. Format data for the technicalindicators library
    const closes = triggerCandles.map(c => c.close);
    const highs = triggerCandles.map(c => c.high);
    const lows = triggerCandles.map(c => c.low);
    const volumes = triggerCandles.map(c => c.volume);

    // 3. Calculate Indicators
    const fastEMA = EMA.calculate({ period: fast_ema_period, values: closes });
    const slowEMA = EMA.calculate({ period: slow_ema_period, values: closes });
    const vwapResult = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });

    if (fastEMA.length < 2 || slowEMA.length < 2 || vwapResult.length < 2) {
        return { signal: null };
    }

    // 4. Extract current and previous values
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const currentVolume = volumes[volumes.length - 1];

    const currentFastEMA = fastEMA[fastEMA.length - 1];
    const currentSlowEMA = slowEMA[slowEMA.length - 1];
    
    const currentVWAP = vwapResult[vwapResult.length - 1];
    const prevVWAP = vwapResult[vwapResult.length - 2];

    let signal = null;

    // 5. Evaluate Trading Logic
    if (currentFastEMA > currentSlowEMA && prevPrice <= prevVWAP && currentPrice > currentVWAP && currentVolume > volume_threshold) {
        signal = 'LONG';
    } else if (currentFastEMA < currentSlowEMA && prevPrice >= prevVWAP && currentPrice < currentVWAP && currentVolume > volume_threshold) {
        signal = 'SHORT';
    }

    // --- THE TELEMETRY FIX ---
    // Define the live data once, using the correct variables for THIS strategy
    const currentTelemetry = {
        fast_ema: parseFloat(currentFastEMA.toFixed(4)),
        vwap: parseFloat(currentVWAP.toFixed(4)),
        volume: currentVolume
    };

    // If there is no trade, exit early but still stream the telemetry!
    if (!signal) {
        return { 
            signal: null, 
            telemetry: currentTelemetry 
        };
    }

    // 6. Calculate Exits
    const tpPrice = signal === 'LONG' 
        ? currentPrice * (1 + tpPercent) 
        : currentPrice * (1 - tpPercent);
        
    const slPrice = signal === 'LONG' 
        ? currentPrice * (1 - slPercent) 
        : currentPrice * (1 + slPercent);

    // 7. Return the Standardized Decision Envelope (Trade Fired!)
    return {
        signal: signal,
        entryPrice: currentPrice,
        leverage: leverage,
        marketType: marketType,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry // Pass the exact same telemetry object here
    };
}