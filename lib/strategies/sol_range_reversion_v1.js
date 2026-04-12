import { BollingerBands, RSI } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    const { 
        leverage = 5, 
        market_type = 'FUTURES', 
        sl_percent = 0.005,
        bb_period = 20,
        bb_stddev = 2,
        rsi_period = 14,
        rsi_overbought = 70,
        rsi_oversold = 30
    } = parameters;

    if (!macroCandles || !triggerCandles || triggerCandles.length < Math.max(bb_period, rsi_period)) {
        return { signal: null };
    }

    const closes = triggerCandles.map(c => c.close);
    const currentClose = closes[closes.length - 1];

    const bb = BollingerBands.calculate({ period: bb_period, stdDev: bb_stddev, values: closes });
    const rsi = RSI.calculate({ period: rsi_period, values: closes });

    if (bb.length === 0 || rsi.length === 0) {
        return { signal: null };
    }

    const currentBB = bb[bb.length - 1];
    const currentRSI = rsi[rsi.length - 1];

    let signal = null;

    if (currentClose <= currentBB.lower && currentRSI <= rsi_oversold) {
        signal = 'LONG';
    } else if (currentClose >= currentBB.upper && currentRSI >= rsi_overbought) {
        signal = 'SHORT';
    }

    const currentTelemetry = {
        rsi: parseFloat(currentRSI.toFixed(2)),
        bb_upper: parseFloat(currentBB.upper.toFixed(4)),
        bb_middle: parseFloat(currentBB.middle.toFixed(4)),
        bb_lower: parseFloat(currentBB.lower.toFixed(4)),
        close: currentClose
    };

    if (!signal) {
        return { signal: null, telemetry: currentTelemetry };
    }

    // DYNAMIC TAKE PROFIT: Target the middle band for mean reversion.
    const tpPrice = currentBB.middle;
    const slPrice = signal === 'LONG' ? currentClose * (1 - sl_percent) : currentClose * (1 + sl_percent);

    return {
        signal: signal,
        entryPrice: currentClose,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry
    };
}