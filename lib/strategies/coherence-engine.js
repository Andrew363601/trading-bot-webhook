import { ADX, SMA } from 'technicalindicators';

/**
 * Consciousness Coherence Math (v3.1)
 * Recreated from Pine Script for Node.js environment.
 * Calculates Market Coherence Index (MCI) based on Trend, Density, and Sync.
 */
export function calculateMCI(candles, params = { adx_len: 14, er_len: 10, threshold: 0.7 }) {
  if (!candles || candles.length < 31) {
    return { mci: 0, is_resonant: false };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // 1. ADX Score (Trend Strength)
  const adxInput = { 
    high: highs, 
    low: lows, 
    close: closes, 
    period: params.adx_len 
  };
  
  const adxResults = ADX.calculate(adxInput);
  const latestADX = adxResults[adxResults.length - 1];
  
  if (!latestADX) return { mci: 0, is_resonant: false };
  const adx_score = Math.min(latestADX.adx / 60, 1.0);

  // 2. Efficiency Ratio (ER - Price Density)
  const currentClose = closes[closes.length - 1];
  const oldClose = closes[closes.length - 1 - params.er_len];
  const priceChange = Math.abs(currentClose - oldClose);
  
  let volatility = 0;
  for (let i = 0; i < params.er_len; i++) {
    volatility += Math.abs(closes[closes.length - 1 - i] - closes[closes.length - 2 - i]);
  }
  const er_score = volatility > 0 ? priceChange / volatility : 0;

  // 3. Sync Score (MA Alignment)
  const sma10 = SMA.calculate({ period: 10, values: closes });
  const sma30 = SMA.calculate({ period: 30, values: closes });
  
  const s10 = sma10[sma10.length - 1];
  const s30 = sma30[sma30.length - 1];
  
  const sync_score = ((currentClose > s10 && s10 > s30) || (currentClose < s10 && s10 < s30)) ? 1.0 : 0.0;

  // 4. Final Aggregation
  const mci = (adx_score + er_score + sync_score) / 3.0;
  
  return {
    mci: parseFloat(mci.toFixed(4)),
    adx: parseFloat(latestADX.adx.toFixed(2)),
    er: parseFloat(er_score.toFixed(4)),
    di_plus: latestADX.pdi,
    di_minus: latestADX.mdi,
    is_resonant: mci >= params.threshold
  };
}