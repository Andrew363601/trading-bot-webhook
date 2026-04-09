// pages/api/scan.js
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
  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    if (!apiKeyName || !apiSecret) {
        return res.status(500).json({ error: "Missing Coinbase Credentials in Vercel Env" });
    }

    const { data: config } = await supabase.from('strategy_config').select('*').eq('strategy', 'LTC_4x4_STF').eq('is_active', true).single();
    const threshold = config?.parameters?.coherence_threshold || 0.7;

    for (const asset of SCAN_ASSETS) {
      try {
        // Fetch Macro (1H) and Trigger (5M)
        const macroCandles = await fetchCoinbaseData(asset, 'ONE_HOUR', apiKeyName, apiSecret);
        const triggerCandles = await fetchCoinbaseData(asset, 'FIVE_MINUTE', apiKeyName, apiSecret);

        // Safety Check: Ensure data exists before mapping
        if (!macroCandles || macroCandles.length < 31 || !triggerCandles || triggerCandles.length < 31) {
            console.error(`[SCANNER] Insufficient data for ${asset}. Skipping.`);
            results.push({ asset, status: "INSUFFICIENT_DATA" });
            continue;
        }

        const macroMCI = calculateMCI(macroCandles, { adx_len: 14, er_len: 10, threshold });
        const triggerMCI = calculateMCI(triggerCandles, { adx_len: 14, er_len: 10, threshold });

        // Multi-Timeframe Confluence Logic
        const isResonant = macroMCI.mci > 0.60 && triggerMCI.mci >= threshold;

        results.push({
          asset,
          macro_mci: macroMCI.mci,
          trigger_mci: triggerMCI.mci,
          status: isResonant ? "RESONANT" : "STABLE"
        });

        if (isResonant) {
          const side = triggerMCI.di_plus > triggerMCI.di_minus ? 'LONG' : 'SHORT';
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers.host;
          
          await fetch(`${protocol}://${host}/api/execute-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: asset.replace('-', ''),
              side,
              price: triggerCandles[triggerCandles.length - 1].close,
              mci: triggerMCI.mci,
              strategy_id: 'LTC_4x4_STF'
            })
          });
        }
      } catch (assetErr) {
        console.error(`[ASSET ERROR] ${asset}:`, assetErr.message);
      }
    }

    return res.status(200).json({ status: "MTF Scan Complete", results });
  } catch (err) {
    console.error("[GLOBAL SCAN FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
    const path = `/api/v3/brokerage/products/${asset}/candles`;
    const end = Math.floor(Date.now() / 1000);
    
    // FIX: Adjust lookback based on granularity to stay under 350 candles
    // 1-Hour: 48 hours = 48 candles
    // 5-Minute: 20 hours = 240 candles (Safe under 350)
    const lookbackHours = granularity === 'ONE_HOUR' ? 48 : 20;
    const start = end - (3600 * lookbackHours); 
    
    const query = `?start=${start}&end=${end}&granularity=${granularity}`;
  
    const token = jwt.sign({
      iss: 'cdp', 
      nbf: Math.floor(Date.now() / 1000), 
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey, 
      uri: `GET api.coinbase.com${path}`,
    }, secret, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });
  
    const resp = await fetch(`https://api.coinbase.com${path}${query}`, { 
        headers: { 'Authorization': `Bearer ${token}` } 
    });
  
    const data = await resp.json();
  
    if (!resp.ok) {
      console.error(`[COINBASE API ERROR] ${asset}:`, data);
      return null;
    }
  
    if (!data.candles || data.candles.length === 0) return null;
  
    return data.candles.map(c => ({ 
        close: parseFloat(c.close), 
        high: parseFloat(c.high), 
        low: parseFloat(c.low) 
    })).reverse();
  }