export async function run(macroCandles, triggerCandles, parameters) {
    // 🎛️ OMNI-STRATEGY PARAMETERS (Pulls from Supabase or uses defaults)
    const { 
        leverage = 10, 
        market_type = 'FUTURES', 
        tp_percent = 0.04, 
        sl_percent = 0.02,
        rsi_period = 14,
        rsi_overbought = 75,
        rsi_oversold = 25
    } = parameters;

    // We need at least 15 candles to calculate ATR and RSI accurately
    if (!macroCandles || !triggerCandles || triggerCandles.length < 15) {
        return { signal: null };
    }

    const current = triggerCandles[triggerCandles.length - 1];
    const previous = triggerCandles[triggerCandles.length - 2];
    const entryPrice = current.close;

    // ==========================================
    // 🧮 1. LOCAL MATH ENGINE
    // ==========================================
    
    // A. ATR (Volatility)
    let trueRanges = [];
    for (let i = triggerCandles.length - 14; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const prev = triggerCandles[i-1];
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    const atr = trueRanges.reduce((a, b) => a + b, 0) / 14;

    // B. RSI (Momentum/Exhaustion)
    let gains = 0, losses = 0;
    for (let i = triggerCandles.length - rsi_period; i < triggerCandles.length; i++) {
        let change = triggerCandles[i].close - triggerCandles[i-1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / rsi_period;
    let avgLoss = losses / rsi_period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    let rsi = 100 - (100 / (1 + rs));

    // C. VWAP (Mean Price)
    let typicalPriceVolume = 0;
    let totalVolume = 0;
    for (let i = 0; i < triggerCandles.length; i++) {
        let c = triggerCandles[i];
        typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume;
        totalVolume += c.volume;
    }
    const vwap = typicalPriceVolume / totalVolume;

    // ==========================================
    // 🎯 2. THE TRIGGER HIERARCHY
    // ==========================================
    let signal = null;
    let microTrend = 'CHOP';

    const breakoutSizeUp = current.close - previous.high;
    const breakoutSizeDown = previous.low - current.close;
    const isVolumeExpanding = current.volume > previous.volume;

    // TRIGGER 1: Volatility Breakout (Trend Expansion)
    if (current.close > previous.high && breakoutSizeUp > (atr * 0.5) && isVolumeExpanding) {
        signal = 'LONG';
        microTrend = 'STRONG_BREAKOUT_UP';
    } 
    else if (current.close < previous.low && breakoutSizeDown > (atr * 0.5) && isVolumeExpanding) {
        signal = 'SHORT';
        microTrend = 'STRONG_BREAKDOWN_DOWN';
    }
    
    // TRIGGER 2: VWAP Bounce (Trend Continuation)
    // If price dipped below VWAP but closed above it (rejecting the drop)
    else if (current.low < vwap && current.close > vwap && current.close > current.open) {
        signal = 'LONG';
        microTrend = 'VWAP_BOUNCE_LONG';
    }
    // If price spiked above VWAP but closed below it (rejecting the pump)
    else if (current.high > vwap && current.close < vwap && current.close < current.open) {
        signal = 'SHORT';
        microTrend = 'VWAP_REJECTION_SHORT';
    }

    // TRIGGER 3: RSI Mean Reversion (Range Fading)
    // If market is heavily overbought and the current candle is printing red (exhaustion)
    else if (rsi > rsi_overbought && current.close < current.open) {
        signal = 'SHORT';
        microTrend = 'RSI_EXHAUSTION_SHORT';
    }
    // If market is heavily oversold and the current candle is printing green (exhaustion)
    else if (rsi < rsi_oversold && current.close > current.open) {
        signal = 'LONG';
        microTrend = 'RSI_EXHAUSTION_LONG';
    }

    // ==========================================
    // 📡 3. TELEMETRY & ROUTING
    // ==========================================
    const currentTelemetry = { 
        micro_trend: microTrend, 
        current_volume: current.volume,
        current_atr: parseFloat(atr.toFixed(2)),
        current_rsi: parseFloat(rsi.toFixed(2)),
        distance_to_vwap: parseFloat(Math.abs(current.close - vwap).toFixed(2)),
        volume_expanding: isVolumeExpanding
    };

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