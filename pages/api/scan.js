import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { calculateMCI } from '../../lib/strategies/coherence-engine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SCAN_ASSETS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'AVAX-USDT'];

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API Credentials");

    const { data: config } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('strategy', 'LTC_4x4_STF')
      .eq('is_active', true)
      .single();

    const threshold = config?.parameters?.coherence_threshold || 0.7;

    for (const asset of SCAN_ASSETS) {
      try {
        const path = `/api/v3/brokerage/products/${asset}/candles`;
        const end = Math.floor(Date.now() / 1000);
        const start = end - (3600 * 48); 
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

        const candles = data.candles.map(c => ({
          close: parseFloat(c.close),
          high: parseFloat(c.high),
          low: parseFloat(c.low)
        })).reverse();

        const metrics = calculateMCI(candles, { 
          adx_len: 14, 
          er_len: 10,
          threshold: threshold
        });

        results.push({
          asset,
          mci: metrics.mci,
          status: metrics.is_resonant ? "RESONANT" : "STABLE"
        });

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
        }
      } catch (assetErr) {
        console.error(`Scanner Error [${asset}]:`, assetErr.message);
      }
    }

    return res.status(200).json({ status: "Scan Complete", results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}