import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { calculateMCI } from '../../lib/strategies/coherence-engine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// The Top 5 Coins we are monitoring
const SCAN_ASSETS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'AVAX-USDT'];

export default async function handler(req, res) {
  // Allow GET for manual Postman testing, POST for cron jobs
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API Credentials");

    // 1. Fetch the active Strategy Config (LTC_4x4) to get thresholds
    const { data: config } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('strategy', 'LTC_4x4_STF')
      .eq('is_active', true)
      .single();

    const threshold = config?.parameters?.coherence_threshold || 0.7;

    console.log(`[SCANNER] Starting multi-asset sweep. Threshold: ${threshold}`);

    // 2. Loop through assets and scan
    for (const asset of SCAN_ASSETS) {
      try {
        const path = `/api/v3/brokerage/products/${asset}/candles`;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (3600 * 48); // Get last 48 hours for indicator warm-up
        const query = `?start=${start}&end=${end}&granularity=ONE_HOUR`;

        const token = jwt.sign(
          {
            iss: 'cdp',
            nbf: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 120,
            sub: apiKeyName,
            uri: `GET api.coinbase.com${path}`,
          },
          apiSecret,
          { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
        );

        const resp = await fetch(`https://api.coinbase.com${path}${query}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await resp.json();
        if (!resp.ok || !data.candles) continue;

        // Map and reverse candles (Coinbase returns newest first)
        const candles = data.candles.map(c => ({
          close: parseFloat(c.close),
          high: parseFloat(c.high),
          low: parseFloat(c.low)
        })).reverse();

        // 3. Execute Coherence Math
        const metrics = calculateMCI(candles, { 
          adx_len: 14, 
          er_len: 10,
          threshold: threshold
        });

        results.push({
          asset,
          mci: metrics.mci,
          status: metrics.is_resonant ? "RESONANT" : "STABLE",
          metrics: { adx: metrics.adx, er: metrics.er }
        });

        // 4. Trigger Auto-Execution if Resonance detected
        if (metrics.is_resonant) {
          const side = metrics.di_plus > metrics.di_minus ? 'LONG' : 'SHORT';
          const protocol = req.headers['x-forwarded-proto'] || 'http';
          const host = req.headers.host;
          
          await fetch(`${protocol}://${host}/api/execute-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: asset.replace('-', ''),
              side: side,
              price: candles[candles.length - 1].close,
              mci: metrics.mci,
              strategy_id: 'LTC_4x4_STF'
            })
          });
          console.log(`[SCANNER] EXECUTION SIGNAL: ${side} ${asset}`);
        }

      } catch (assetErr) {
        console.error(`Error scanning ${asset}:`, assetErr.message);
      }
    }

    return res.status(200).json({ 
        status: "Scan Complete", 
        timestamp: new Date().toISOString(),
        results 
    });

  } catch (err) {
    console.error("[SCAN FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}