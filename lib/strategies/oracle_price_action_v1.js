export async function run(macroCandles, triggerCandles, parameters) {
    // 🟢 THE UPGRADE: Dynamic Volatility and Volume Parameters
    const { leverage = 10, market_type = 'FUTURES', atr_multiplier = 1.5, tp_multiplier = 3.0 } = parameters;

    // Require enough history to calculate ATR and Volume Moving Averages
    if (!macroCandles || !triggerCandles || triggerCandles.length < 20) {
        return { signal: null };
    }

    const current = triggerCandles[triggerCandles.length - 1];
    const previous = triggerCandles[triggerCandles.length - 2];
    const entryPrice = current.close;

    // 1. Calculate Average True Range (ATR) for dynamic volatility mapping
    let trueRanges = [];
    for (let i = 1; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const p = triggerCandles[i - 1];
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    const atr = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length);

    // 2. Calculate 20-Period Volume SMA to detect Institutional Footprints
    const volSlice = triggerCandles.slice(-20);
    const avgVolume = volSlice.reduce((sum, c) => sum + c.volume, 0) / volSlice.length;

    let signal = null;
    let microTrend = 'CHOP';

    // 🟢 THE NEW TRIPWIRE: Breakout + Volume Expansion (Ignoring low-volume fake-outs)
    if (current.close > previous.high && current.volume > (avgVolume * 1.2)) {
        signal = 'LONG';
        microTrend = 'VOLUME_BREAKOUT_UP';
    } else if (current.close < previous.low && current.volume > (avgVolume * 1.2)) {
        signal = 'SHORT';
        microTrend = 'VOLUME_BREAKDOWN_DOWN';
    }

    const currentTelemetry = { 
        micro_trend: microTrend, 
        current_volume: current.volume,
        avg_volume_20: parseFloat(avgVolume.toFixed(2)),
        current_atr: parseFloat(atr.toFixed(2))
    };

    if (!signal) return { signal: null, telemetry: currentTelemetry };

    // 🟢 DYNAMIC TARGETS: ATR Armor prevents arbitrary stop-hunts
    const tpDistance = atr * tp_multiplier;
    const slDistance = atr * atr_multiplier;

    const tpPrice = signal === 'LONG' ? entryPrice + tpDistance : entryPrice - tpDistance;
    const slPrice = signal === 'LONG' ? entryPrice - slDistance : entryPrice + slDistance;

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