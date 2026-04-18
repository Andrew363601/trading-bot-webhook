export async function run(macroCandles, triggerCandles, parameters) {
    const { leverage = 10, market_type = 'FUTURES', tp_percent = 0.04, sl_percent = 0.02 } = parameters;

    // We need at least 15 candles now to calculate a 14-period ATR accurately
    if (!macroCandles || !triggerCandles || triggerCandles.length < 15) {
        return { signal: null };
    }

    const current = triggerCandles[triggerCandles.length - 1];
    const previous = triggerCandles[triggerCandles.length - 2];
    const entryPrice = current.close;

    // --- 🛡️ DEFENSE 3: MATHEMATICAL VOLATILITY FILTER (ATR) ---
    // Calculate a local 14-period ATR to determine the current market chop level
    let trueRanges = [];
    for (let i = triggerCandles.length - 14; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const prev = triggerCandles[i-1];
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    const atr = trueRanges.reduce((a, b) => a + b, 0) / 14;

    // Calculate the actual size of the current breakout move
    const breakoutSizeUp = current.close - previous.high;
    const breakoutSizeDown = previous.low - current.close;

    let signal = null;
    let microTrend = 'CHOP';

    // The core rule: The breakout must be larger than 50% of the recent average volatility (ATR).
    // This physically filters out tiny, low-momentum ticks in a sideways market.
    const isVolumeExpanding = current.volume > previous.volume;

    if (current.close > previous.high && breakoutSizeUp > (atr * 0.5) && isVolumeExpanding) {
        signal = 'LONG';
        microTrend = 'STRONG_BREAKOUT_UP';
    } else if (current.close < previous.low && breakoutSizeDown > (atr * 0.5) && isVolumeExpanding) {
        signal = 'SHORT';
        microTrend = 'STRONG_BREAKDOWN_DOWN';
    }

    const currentTelemetry = { 
        micro_trend: microTrend, 
        current_volume: current.volume,
        previous_volume: previous.volume,
        current_atr: parseFloat(atr.toFixed(2)),
        volume_expanding: isVolumeExpanding
    };

    if (!signal) return { signal: null, telemetry: currentTelemetry };

    // --- THE FALLBACK MATH ---
    // These are now just safety nets. The Oracle will override these 
    // with its dynamic Order Book targets if it approves the trade.
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