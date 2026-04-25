export async function run(macroCandles, triggerCandles, parameters) {
    // Pure Price Action & Volume - 100% reliance on the Oracle LLM
    const { leverage = 10, market_type = 'FUTURES', tp_percent = 0.04, sl_percent = 0.02 } = parameters;

    if (!macroCandles || !triggerCandles || triggerCandles.length < 5) {
        return { signal: null };
    }

    const current = triggerCandles[triggerCandles.length - 1];
    const previous = triggerCandles[triggerCandles.length - 2];
    const entryPrice = current.close;

    let signal = null;
    let microTrend = 'CHOP';

    // Basic Micro-Breakout Detection
    if (current.close > previous.high) {
        signal = 'LONG';
        microTrend = 'BREAKOUT_UP';
    } else if (current.close < previous.low) {
        signal = 'SHORT';
        microTrend = 'BREAKDOWN_DOWN';
    }

    const currentTelemetry = { 
        micro_trend: microTrend, 
        current_volume: current.volume,
        previous_volume: previous.volume 
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