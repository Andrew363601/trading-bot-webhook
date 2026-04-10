import { ADX, SMA } from 'technicalindicators';

// 1. THE STANDARDIZED INTERFACE (Called by the Dynamic Router)
export async function run(macroCandles, triggerCandles, parameters) {
    // Extract parameters with safe fallbacks
    const threshold = parameters?.coherence_threshold || parameters?.mci_threshold || 0.7;
    const leverage = parameters?.leverage || 1;
    const marketType = parameters?.market_type || 'SPOT';
    const tpPercent = parameters?.target_profit_percentage || parameters?.tp_percent;
    const slPercent = parameters?.stop_loss_percentage || parameters?.sl_percent;
    
    // Run the core math
    const macroMCI = calculateMCI(macroCandles, { adx_len: 14, er_len: 10, threshold });
    const triggerMCI = calculateMCI(triggerCandles, { adx_len: 14, er_len: 10, threshold });

    // Resonance Check
    const isResonant = macroMCI.mci > 0.60 && triggerMCI.is_resonant;
    
    // If conditions aren't met, return a null signal safely
    if (!isResonant) return { signal: null, mci: triggerMCI.mci };

    // Determine Direction and Entry Price
    const side = triggerMCI.di_plus > triggerMCI.di_minus ? 'LONG' : 'SHORT';
    const entryPrice = triggerCandles[triggerCandles.length - 1].close;

    // Calculate Dynamic Exits based on database parameters
    let tpPrice = null;
    let slPrice = null;

    if (tpPercent) {
        tpPrice = side === 'LONG' 
            ? entryPrice * (1 + tpPercent) 
            : entryPrice * (1 - tpPercent);
    }

    if (slPercent) {
        slPrice = side === 'LONG'
            ? entryPrice * (1 - slPercent)
            : entryPrice * (1 + slPercent);
    }

    // Return the Standardized Decision Envelope back to scan.js
    return {
        signal: side,
        entryPrice: entryPrice,
        mci: triggerMCI.mci,
        leverage: leverage,
        marketType: marketType,
        tpPrice: tpPrice ? parseFloat(tpPrice.toFixed(6)) : null,
        slPrice: slPrice ? parseFloat(slPrice.toFixed(6)) : null
    };
}

// 2. THE RAW MATH ENGINE (Helper function)
function calculateMCI(candles, params = { adx_len: 14, er_len: 10, threshold: 0.7 }) {
  if (!candles || candles.length < 31) return { mci: 0, is_resonant: false };

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const adxResults = ADX.calculate({ high: highs, low: lows, close: closes, period: params.adx_len });
  const latestADX = adxResults[adxResults.length - 1];
  if (!latestADX) return { mci: 0, is_resonant: false };

  const adx_score = Math.min(latestADX.adx / 60, 1.0);
  const currentClose = closes[closes.length - 1];
  const priceChange = Math.abs(currentClose - closes[closes.length - 1 - params.er_len]);
  
  let volatility = 0;
  for (let i = 0; i < params.er_len; i++) {
    volatility += Math.abs(closes[closes.length - 1 - i] - closes[closes.length - 2 - i]);
  }
  const er_score = volatility > 0 ? priceChange / volatility : 0;

  const sma10 = SMA.calculate({ period: 10, values: closes });
  const sma30 = SMA.calculate({ period: 30, values: closes });
  const s10 = sma10[sma10.length - 1], s30 = sma30[sma30.length - 1];
  const sync_score = ((currentClose > s10 && s10 > s30) || (currentClose < s10 && s10 < s30)) ? 1.0 : 0.0;

  const mci = (adx_score + er_score + sync_score) / 3.0;
  return {
    mci: parseFloat(mci.toFixed(4)),
    di_plus: latestADX.pdi,
    di_minus: latestADX.mdi,
    is_resonant: mci >= params.threshold
  };
}