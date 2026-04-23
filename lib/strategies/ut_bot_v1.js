// lib/strategies/ut_bot_v1.js
import { EMA } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    const {
        leverage = 10, market_type = 'FUTURES', tp_percent = 0.022, sl_percent = 0.011,
        atr_period = 10, key_value = 1.5, use_ema_filter = true, ema_len = 200
    } = parameters;

    // Failsafe: Ensure we have enough data to calculate the math
    if (!macroCandles || !triggerCandles || triggerCandles.length < 50) {
        return { signal: null, telemetry: { status: "WARMUP_NOT_ENOUGH_CANDLES" } };
    }

    // =========================================================================
    // 1. NATIVE TRADINGVIEW ATR & UT BOT MATH (Crash-Proof Index Alignment)
    // =========================================================================
    let atr = [];
    for (let i = 0; i < triggerCandles.length; i++) {
        if (i === 0) { 
            atr.push(triggerCandles[i].high - triggerCandles[i].low); 
            continue; 
        }
        const tr = Math.max(
            triggerCandles[i].high - triggerCandles[i].low,
            Math.abs(triggerCandles[i].high - triggerCandles[i-1].close),
            Math.abs(triggerCandles[i].low - triggerCandles[i-1].close)
        );
        if (i < atr_period) {
            atr.push(tr);
        } else {
            // RMA (Rolling Moving Average) - This is exactly what TradingView uses
            atr.push((atr[i-1] * (atr_period - 1) + tr) / atr_period); 
        }
    }

    let xATRTrailingStop = new Array(triggerCandles.length).fill(0);
    let position = new Array(triggerCandles.length).fill(0);

    for (let i = 1; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const prevC = triggerCandles[i-1];
        const nLoss = key_value * atr[i];

        // Trailing Stop Mathematical Logic
        if (c.close > xATRTrailingStop[i-1] && prevC.close > xATRTrailingStop[i-1]) {
            xATRTrailingStop[i] = Math.max(xATRTrailingStop[i-1], c.close - nLoss);
        } else if (c.close < xATRTrailingStop[i-1] && prevC.close < xATRTrailingStop[i-1]) {
            xATRTrailingStop[i] = Math.min(xATRTrailingStop[i-1], c.close + nLoss);
        } else if (c.close > xATRTrailingStop[i-1]) {
            xATRTrailingStop[i] = c.close - nLoss;
        } else {
            xATRTrailingStop[i] = c.close + nLoss;
        }

        // Vector Flip Logic (1 = LONG, -1 = SHORT)
        if (prevC.close < xATRTrailingStop[i-1] && c.close > xATRTrailingStop[i-1]) {
            position[i] = 1; 
        } else if (prevC.close > xATRTrailingStop[i-1] && c.close < xATRTrailingStop[i-1]) {
            position[i] = -1; 
        } else {
            position[i] = position[i-1];
        }
    }

    // =========================================================================
    // 2. THE X-RAY CVD PRE-FILTER (Replaces laggy RSI/Volume MA)
    // =========================================================================
    let localCvd = 0;
    const cvdLookback = Math.min(10, triggerCandles.length);
    for (let i = triggerCandles.length - cvdLookback; i < triggerCandles.length; i++) {
        const c = triggerCandles[i];
        const range = c.high - c.low;
        let openPrice = c.open !== undefined && !isNaN(c.open) ? parseFloat(c.open) : (i > 0 ? triggerCandles[i-1].close : c.close);
        if (range > 0) localCvd += c.volume * ((c.close - openPrice) / range);
    }

    // =========================================================================
    // 3. MACRO REGIME FILTER
    // =========================================================================
    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    let macroEmaVal = 0;
    
    if (use_ema_filter) {
        const macroCloses = macroCandles.map(c => c.close);
        const safeEmaLen = Math.min(ema_len, macroCloses.length);
        const emaArray = EMA.calculate({ period: safeEmaLen, values: macroCloses });
        macroEmaVal = emaArray.length > 0 ? emaArray[emaArray.length - 1] : currentPrice;
    }

    // =========================================================================
    // 4. SIGNAL EVALUATION
    // =========================================================================
    const currentPos = position[position.length - 1];
    const prevPos = position[position.length - 2];

    let signal = null;
    let status = 'WAITING';

    // Did the UT Bot flip on this exact 1-minute candle?
    if (currentPos === 1 && prevPos === -1) {
        if (localCvd > 0 && (!use_ema_filter || currentPrice > macroEmaVal)) {
            signal = 'LONG';
            status = 'UT_BOT_LONG_TRIGGERED';
        } else {
            status = 'PRE_VETOED_BY_CVD_OR_EMA';
        }
    } else if (currentPos === -1 && prevPos === 1) {
        if (localCvd < 0 && (!use_ema_filter || currentPrice < macroEmaVal)) {
            signal = 'SHORT';
            status = 'UT_BOT_SHORT_TRIGGERED';
        } else {
            status = 'PRE_VETOED_BY_CVD_OR_EMA';
        }
    }

    const currentTelemetry = {
        status: status,
        ut_bot_state: currentPos === 1 ? 'LONG' : 'SHORT',
        local_cvd: parseFloat(localCvd.toFixed(2)),
        macro_ema: parseFloat(macroEmaVal.toFixed(2))
    };

    if (!signal) return { signal: null, telemetry: currentTelemetry };

    const tpPrice = signal === 'LONG' ? currentPrice * (1 + tp_percent) : currentPrice * (1 - tp_percent);
    const slPrice = signal === 'LONG' ? currentPrice * (1 - sl_percent) : currentPrice * (1 + sl_percent);

    return {
        signal: signal,
        entryPrice: currentPrice,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: currentTelemetry
    };
}