import { EMA, ATR } from 'technicalindicators';

export async function run(macroCandles, triggerCandles, parameters) {
    // 1. Setup Parameters (Catching your dynamic Target USD)
    const {
        leverage = 10,
        market_type = 'FUTURES',
        ema_period = 20,
        atr_period = 10,
        multiplier = 1.5,
        sl_percent = 0.0040, // 0.40% DOGE Sweet Spot
        target_usd = 5000    // Leveraged Position Size ($500 margin x 10 leverage)
    } = parameters;

    // 2. MTF Logic: Calculate Keltner on Macro (5m)
    if (!macroCandles || macroCandles.length < Math.max(ema_period, atr_period) + 1) {
        return { signal: null, telemetry: { error: 'Insufficient Macro history' } };
    }

    const closes = macroCandles.map(c => c.close);
    const highs = macroCandles.map(c => c.high);
    const lows = macroCandles.map(c => c.low);

    const emaVals = EMA.calculate({ period: ema_period, values: closes });
    const atrVals = ATR.calculate({ period: atr_period, high: highs, low: lows, close: closes });

    const currentEMA = emaVals[emaVals.length - 1];
    const currentATR = atrVals[atrVals.length - 1];
    const upper = currentEMA + (multiplier * currentATR);
    const lower = currentEMA - (multiplier * currentATR);

    // 3. Signal Generation: Trigger on (1m)
    const currentPrice = triggerCandles[triggerCandles.length - 1].close;
    let signal = null;

    if (currentPrice < lower) {
        signal = 'LONG';
    } else if (currentPrice > upper) {
        signal = 'SHORT';
    }

    const telemetry = { upper, lower, mid: currentEMA, currentPrice };
    if (!signal) return { signal: null, telemetry };

    // 4. Order Sizing Calculations
    // Convert the $5,000 target into the exact amount of coins needed for the Bybit API
    const orderQty = target_usd / currentPrice;
    const marginRequired = target_usd / leverage; 

    // 5. TP/SL Calculation
    const tpPrice = currentEMA; 
    const slPrice = signal === 'LONG' 
        ? currentPrice * (1 - sl_percent) 
        : currentPrice * (1 + sl_percent);

    // 6. Final Execution Payload
    return {
        signal: signal,
        entryPrice: currentPrice,
        qty: parseFloat(orderQty.toFixed(0)), // Bybit usually requires whole numbers for cheap coins like DOGE
        positionValueUsd: target_usd,
        marginUsedUsd: marginRequired,
        leverage: leverage,
        marketType: market_type,
        tpPrice: parseFloat(tpPrice.toFixed(6)),
        slPrice: parseFloat(slPrice.toFixed(6)),
        telemetry: telemetry
    };
}