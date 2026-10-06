// AM58 C2 smoke — calibrated proxy must classify a strong-displacement series
// as TREND (was TREND-blind at DISPLACEMENT_TREND=1.2).
import { classifyRegimeProxy, REGIME_PROXY_CONSTANTS } from '../lib/regime-proxy.js';

// Strong uptrend: steady drift with modest noise -> high |ema50 slope|/ATR14.
const candles = [];
let p = 100;
for (let i = 0; i < 400; i++) {
  p += 0.5 + (i % 3 === 0 ? 0.1 : -0.05);
  candles.push({ open: p - 0.2, high: p + 0.3, low: p - 0.3, close: p, volume: 10 });
}

const label = classifyRegimeProxy(candles);
console.log('constants:', JSON.stringify(REGIME_PROXY_CONSTANTS));
console.log('label:', label);
const ok = label === 'TREND';
console.log(ok ? 'PASS  strong-displacement series -> TREND' : `FAIL  expected TREND, got ${label}`);
process.exit(ok ? 0 : 1);
