import { EMA, RSI, MACD } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    const {
        leverage = 10,
        market_type = 'FUTURES',
        tp_percent = 0.02,
        sl_percent = 0.01,
        slow_ema_period = 200,
        fast_ema_period = 50,
        rsi_period = 14,
        rsi_level = 50,
        macd_fast_period = 12,
        macd_slow_period = 26,
        macd_signal_period = 9
    } = parameters;

    // Default Telemetry structure to ensure it NEVER returns {}
    let currentTelemetry = {
        macro_trend: 'WAITING',
        rsi: 0,
        macd_hist: 0
    };

    // 1. Initial Safety Check
    if (!macroCandles || !triggerCandles || triggerCandles.length < 50 || macroCandles.length < 50) {
        return { signal: null, telemetry: currentTelemetry };
    }

    const triggerCloses = triggerCandles.map(c => c.close);
    const macroCloses = macroCandles.map(c => c.close);
    const entryPrice = triggerCloses[triggerCloses.length - 1];

    // 2. MACRO TREND CALCULATION (Calculated on the 5m Timeframe)
    const macroSlow = EMA.calculate({ period: slow_ema_period, values: macroCloses });
    const macroFast = EMA.calculate({ period: fast_ema_period, values: macroCloses });
    
    const lastMacroSlow = macroSlow[macroSlow.length - 1];
    const lastMacroFast = macroFast[macroFast.length - 1];
    const macroTrend = lastMacroFast > lastMacroSlow ? 'UP' : 'DOWN';

    // 3. TRIGGER INDICATORS (Calculated on the 1m Timeframe)
    const rsi = RSI.calculate({ period: rsi_period, values: triggerCloses });
    const macd = MACD.calculate({
        values: triggerCloses,
        fastPeriod: macd_fast_period,
        slowPeriod: macd_slow_period,
        signalPeriod: macd_signal_period,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });

    const lastRsi = rsi[rsi.length - 1] || 0;
    const lastMacd = macd[macd.length - 1];

    // Populate live telemetry
    currentTelemetry = {
        macro_trend: macroTrend,
        rsi: parseFloat(lastRsi.toFixed(2)),
        macd_hist: lastMacd ? parseFloat(lastMacd.histogram.toFixed(4)) : 0
    };

    if (!lastMacd || !lastMacroSlow) {
        return { signal: null, telemetry: currentTelemetry };
    }

    // 4. ENTRY LOGIC
    let signal = null;
    const isRsiBullish = lastRsi > rsi_level;
    const isMacdCrossover = lastMacd.MACD > lastMacd.signal;

    const isRsiBearish = lastRsi < rsi_level;
    const isMacdCrossunder = lastMacd.MACD < lastMacd.signal;

    if (macroTrend === 'UP' && isRsiBullish && isMacdCrossover) {
        signal = 'LONG';
    } else if (macroTrend === 'DOWN' && isRsiBearish && isMacdCrossunder) {
        signal = 'SHORT';
    }

    if (!signal) {
        return { signal: null, telemetry: currentTelemetry };
    }

    // 5. EXIT CALCULATIONS
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