// lib/strategies/ut_bot_v1.js
import { ATR, EMA, RSI, SMA } from 'technicalindicators';

// Helper function to calculate the ATR Trailing Stop 
function calculateAtrTrailingStop(candles, atrPeriod, sensitivity) { 
    const atr = ATR.calculate({ 
        high: candles.map(c => c.high), 
        low: candles.map(c => c.low), 
        close: candles.map(c => c.close), 
        period: atrPeriod 
    }); 
    
    let trailingStop = []; 
    let nLoss = sensitivity * atr[atr.length - 1]; 
    
    for (let i = 0; i < candles.length; i++) { 
        if (i === 0) { 
            trailingStop.push(candles[i].close - nLoss); 
            continue; 
        } 
        let prevStop = trailingStop[i - 1]; 
        let currentClose = candles[i].close; 
        let prevClose = candles[i-1].close; 
        
        if (currentClose > prevStop && prevClose > prevStop) { 
            trailingStop.push(Math.max(prevStop, currentClose - nLoss)); 
        } else if (currentClose < prevStop && prevClose < prevStop) { 
            trailingStop.push(Math.min(prevStop, currentClose + nLoss)); 
        } else if (currentClose > prevStop) { 
            trailingStop.push(currentClose - nLoss); 
        } else { 
            trailingStop.push(currentClose + nLoss); 
        } 
    } 
    return trailingStop; 
}

export async function run(macroCandles, triggerCandles, parameters) { 
    // ========================================== 
    // 1. DESTRUCTURE PARAMETERS 
    // ========================================== 
    const { 
        leverage = 10, 
        market_type = 'FUTURES', 
        tp_percent = 0.0055, 
        sl_percent = 0.011, 
        key_value = 1.0, 
        atr_period = 10, 
        use_ema_filter = true, 
        ema_len = 200, 
        use_vol_filter = true, 
        vol_ma_len = 50, 
        use_rsi_filter = true, 
        rsi_ob = 70, 
        rsi_os = 30 
    } = parameters; 

    // ========================================== 
    // 2. CHECK FOR SUFFICIENT DATA 
    // ========================================== 
    if (!macroCandles || !triggerCandles || triggerCandles.length < ema_len || macroCandles.length < ema_len) { 
        return { signal: null, telemetry: { message: "Insufficient data" } }; 
    } 

    // ========================================== 
    // 3. INDICATOR CALCULATIONS 
    // ========================================== 
    const closes = triggerCandles.map(c => c.close); 
    const currentPrice = closes[closes.length - 1]; 
    
    const atrTrailingStopValues = calculateAtrTrailingStop(triggerCandles, atr_period, key_value); 
    const xATRTrailingStop = atrTrailingStopValues[atrTrailingStopValues.length - 1]; 
    const prevAtrStop = atrTrailingStopValues[atrTrailingStopValues.length - 2]; 
    
    const emaSrc = EMA.calculate({ period: 1, values: closes }); 
    const currentEmaSrc = emaSrc[emaSrc.length - 1]; 
    const prevEmaSrc = emaSrc[emaSrc.length - 2]; 
    
    const macro_ema = EMA.calculate({ period: ema_len, values: macroCandles.map(c => c.close) }); 
    const current_macro_ema = macro_ema[macro_ema.length - 1]; 
    
    const volume = triggerCandles.map(c => c.volume); 
    const vol_ma = SMA.calculate({ period: vol_ma_len, values: volume }); 
    const current_vol_ma = vol_ma[vol_ma.length - 1]; 
    const current_volume = volume[volume.length - 1]; 
    
    const rsi = RSI.calculate({ period: 14, values: closes }); 
    const current_rsi = rsi[rsi.length - 1]; 

    // ========================================== 
    // 4. SIGNAL GENERATION 
    // ========================================== 
    let signal = null; 
    
    const trend_bull = use_ema_filter ? (currentPrice > current_macro_ema) : true; 
    const trend_bear = use_ema_filter ? (currentPrice < current_macro_ema) : true; 
    const strong_volume = use_vol_filter ? (current_volume > current_vol_ma) : true; 
    const safe_long = use_rsi_filter ? (current_rsi < rsi_ob) : true; 
    const safe_short = use_rsi_filter ? (current_rsi > rsi_os) : true; 
    
    const above = currentEmaSrc > xATRTrailingStop && prevEmaSrc <= prevAtrStop; 
    const below = currentEmaSrc < xATRTrailingStop && prevEmaSrc >= prevAtrStop; 
    
    const buy_condition = currentPrice > xATRTrailingStop && above && trend_bull && strong_volume && safe_long; 
    const sell_condition = currentPrice < xATRTrailingStop && below && trend_bear && strong_volume && safe_short; 
    
    if (buy_condition) { 
        signal = 'LONG'; 
    } else if (sell_condition) { 
        signal = 'SHORT'; 
    } 

    // ========================================== 
    // 5. TELEMETRY & EXECUTION PAYLOAD 
    // ========================================== 
    const telemetry = { 
        atr_stop: xATRTrailingStop, 
        macro_ema: current_macro_ema, 
        volume_ma: current_vol_ma, 
        current_volume: current_volume, 
        rsi: current_rsi, 
        is_bull_trend: trend_bull, 
        has_strong_volume: strong_volume, 
        is_safe_long: safe_long 
    }; 
    
    if (!signal) { 
        return { signal: null, telemetry: telemetry }; 
    } 
    
    const entryPrice = currentPrice; 
    const tpPrice = signal === 'LONG' ? entryPrice * (1 + tp_percent) : entryPrice * (1 - tp_percent); 
    const slPrice = signal === 'LONG' ? entryPrice * (1 - sl_percent) : entryPrice * (1 + sl_percent); 
    
    return { 
        signal: signal, 
        entryPrice: entryPrice, 
        leverage: leverage, 
        marketType: market_type, 
        tpPrice: parseFloat(tpPrice.toFixed(6)), 
        slPrice: parseFloat(slPrice.toFixed(6)), 
        telemetry: telemetry 
    }; 
}