// lib/strategies/coherence-engine.js
import { ADX, SMA, ATR } from 'technicalindicators';

export function calculateCoherence(candles, params = { adx_len: 14, er_len: 10, threshold: 0.7 }) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // 1. ADX Score
  const adxInput = { high: highs, low: lows, close: closes, period: params.adx_len };
  const adxResults = ADX.calculate(adxInput);
  const latestADX = adxResults[adxResults.length - 1];
  const adx_score = Math.min(latestADX.adx / 60, 1.0);

  // 2. Efficiency Ratio (ER) Score
  const currentClose = closes[closes.length - 1];
  const oldClose = closes[closes.length - 1 - params.er_len];
  const priceChange = Math.abs(currentClose - oldClose);
  
  let volatility = 0;
  for (let i = 0; i < params.er_len; i++) {
    volatility += Math.abs(closes[closes.length - 1 - i] - closes[closes.length - 2 - i]);
  }
  const er_score = volatility > 0 ? priceChange / volatility : 0;

  // 3. Sync Score (SMA 10 vs 30)
  const sma10 = SMA.calculate({ period: 10, values: closes });
  const sma30 = SMA.calculate({ period: 30, values: closes });
  
  const s10 = sma10[sma10.length - 1];
  const s30 = sma30[sma30.length - 1];
  const sync_score = ((currentClose > s10 && s10 > s30) || (currentClose < s10 && s10 < s30)) ? 1.0 : 0.0;

  // 4. Final MCI Calculation
  const mci = (adx_score + er_score + sync_score) / 3.0;
  
  // Triggers
  const is_resonant = mci > params.threshold;
  const side = latestADX.pdi > latestADX.mdi ? 'BUY' : 'SELL';

  return {
    mci: mci.toFixed(4),
    is_resonant,
    side,
    adx: latestADX.adx.toFixed(2),
    er: er_score.toFixed(4)
  };
}