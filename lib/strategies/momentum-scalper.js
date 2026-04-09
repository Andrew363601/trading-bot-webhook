// lib/strategies/momentum-scalper.js
import { RSI, SMA } from 'technicalindicators';

export function calculateMomentum(candles, params = { rsi_len: 10, vol_threshold: 2.0 }) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // 1. RSI Calculation
  const rsiResults = RSI.calculate({ values: closes, period: params.rsi_len });
  const latestRSI = rsiResults[rsiResults.length - 1];

  // 2. Volume Spike Detection
  const avgVolume = SMA.calculate({ period: 20, values: volumes });
  const currentVol = volumes[volumes.length - 1];
  const volSpike = currentVol / avgVolume[avgVolume.length - 1];

  // Logic: Oversold + Volume Surge = Potential Long
  const is_resonant = latestRSI < 35 && volSpike > params.vol_threshold;

  return {
    rsi: latestRSI.toFixed(2),
    vol_spike: volSpike.toFixed(2),
    is_resonant,
    side: 'BUY'
  };
}