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

    if (!macroCandles || !triggerCandles || triggerCandles.length < slow_ema_period) {
        return { signal: null };
    }

    let signal = null;
    const entryPrice = triggerCandles[triggerCandles.length - 1].close;
    const triggerCloses = triggerCandles.map(c => c.close);

    // Indicators
    const slowEma = EMA.calculate({ period: slow_ema_period, values: triggerCloses });
    const fastEma = EMA.calculate({ period: fast_ema_period, values: triggerCloses });
    const rsi = RSI.calculate({ period: rsi_period, values: triggerCloses });
    const macdInput = {
        values: triggerCloses,
        fastPeriod: macd_fast_period,
        slowPeriod: macd_slow_period,
        signalPeriod: macd_signal_period,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    };
    const macd = MACD.calculate(macdInput);

    const lastSlowEma = slowEma[slowEma.length - 1];
    const lastFastEma = fastEma[fastEma.length - 1];
    const lastRsi = rsi[rsi.length - 1];
    const lastMacd = macd[macd.length - 1];

    const currentTelemetry = {
        slow_ema: lastSlowEma,
        fast_ema: lastFastEma,
        rsi: lastRsi,
        macd_histogram: lastMacd ? lastMacd.histogram : null
    };

    if (!lastMacd) {
        return { signal: null, telemetry: currentTelemetry };
    }

    // Entry Conditions
    const isLongTrend = lastFastEma > lastSlowEma;
    const isRsiBullish = lastRsi > rsi_level;
    const isMacdCrossover = lastMacd.MACD > lastMacd.signal;

    const isShortTrend = lastFastEma < lastSlowEma;
    const isRsiBearish = lastRsi < rsi_level;
    const isMacdCrossunder = lastMacd.MACD < lastMacd.signal;

    if (isLongTrend && isRsiBullish && isMacdCrossover) {
        signal = 'LONG';
    } else if (isShortTrend && isRsiBearish && isMacdCrossunder) {
        signal = 'SHORT';
    }

    if (!signal) {
        return { signal: null, telemetry: currentTelemetry };
    }

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