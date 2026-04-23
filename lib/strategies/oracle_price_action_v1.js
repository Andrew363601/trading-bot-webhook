export async function run(macroCandles, triggerCandles, parameters) {
    const { leverage = 10, market_type = 'FUTURES', tp_percent = 0.04, sl_percent = 0.02 } = parameters;

    // We need at least 15 candles now to calculate a 14-period ATR accurately
    if (!macroCandles || !triggerCandles || triggerCandles.length < 15) {
        return { signal: null };
    }

    const current = triggerCandles[triggerCandles.length - 1];
    const previous = triggerCandles[triggerCandles.length - 2];
    const entryPrice = current.close;

    // --- 🛡️ DEFENSE 1: MATHEMATICAL VOLATILITY FILTER (ATR) ---
    let trueRanges = [];
    for (let i = triggerCandles.length - 14; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const prev = triggerCandles[i-1];
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    const atr = trueRanges.reduce((a, b) => a + b, 0) / 14;

    // --- 🛡️ DEFENSE 2: LOCAL CVD (ORDER FLOW PRE-FILTER) ---
    // Calculate CVD for just the last 10 candles to see immediate buying/selling pressure
    let localCvd = 0;
    const cvdLookback = Math.min(10, triggerCandles.length);
    for (let i = triggerCandles.length - cvdLookback; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const range = c.high - c.low;
        // Safely parse open price
        let openPrice = c.open !== undefined && !isNaN(c.open) ? parseFloat(c.open) : (i > 0 ? triggerCandles[i-1].close : c.close);
        
        if (range > 0) {
            localCvd += c.volume * ((c.close - openPrice) / range);
        }
    }

    // Calculate the actual size of the current breakout move
    const breakoutSizeUp = current.close - previous.high;
    const breakoutSizeDown = previous.low - current.close;

    let signal = null;
    let microTrend = 'CHOP';

    const isVolumeExpanding = current.volume > previous.volume;

    // THE RULE: Breakout must be > 50% ATR, Volume must be expanding, AND CVD MUST MATCH DIRECTION.
    if (current.close > previous.high && breakoutSizeUp > (atr * 0.5) && isVolumeExpanding) {
        if (localCvd > 0) {
            signal = 'LONG';
            microTrend = 'STRONG_BREAKOUT_UP';
        } else {
            microTrend = 'TRAP_DETECTED_CVD_NEGATIVE'; // Pre-filtered!
        }
    } else if (current.close < previous.low && breakoutSizeDown > (atr * 0.5) && isVolumeExpanding) {
        if (localCvd < 0) {
            signal = 'SHORT';
            microTrend = 'STRONG_BREAKDOWN_DOWN';
        } else {
            microTrend = 'TRAP_DETECTED_CVD_POSITIVE'; // Pre-filtered!
        }
    }

    const currentTelemetry = { 
        micro_trend: microTrend, 
        current_volume: current.volume,
        previous_volume: previous.volume,
        current_atr: parseFloat(atr.toFixed(2)),
        local_cvd: parseFloat(localCvd.toFixed(2)),
        volume_expanding: isVolumeExpanding
    };

    if (!signal) return { signal: null, telemetry: currentTelemetry };

    // --- THE FALLBACK MATH ---
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