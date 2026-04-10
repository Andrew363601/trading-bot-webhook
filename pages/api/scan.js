// pages/api/scan.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { calculateMCI } from '../../lib/strategies/coherence-engine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    // 1. Fetch ALL active strategies from the DB
    const { data: activeConfigs, error: configErr } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('is_active', true);

    if (configErr) throw new Error(configErr.message);
    if (!activeConfigs || activeConfigs.length === 0) {
        return res.status(200).json({ status: "No active strategies to scan." });
    }

    // 2. Loop through every active strategy row independently
    for (const config of activeConfigs) {
      const asset = config.asset;
      if (!asset) continue;

      try {
        const threshold = config.parameters?.coherence_threshold || 0.7;
        const macroCandles = await fetchCoinbaseData(asset, 'ONE_HOUR', apiKeyName, apiSecret);
        const triggerCandles = await fetchCoinbaseData(asset, 'FIVE_MINUTE', apiKeyName, apiSecret);

        if (!macroCandles || macroCandles.length < 31 || !triggerCandles || triggerCandles.length < 31) {
            results.push({ asset, strategy: config.strategy, status: "INSUFFICIENT_DATA" });
            continue;
        }

        const macroMCI = calculateMCI(macroCandles, { adx_len: 14, er_len: 10, threshold });
        const triggerMCI = calculateMCI(triggerCandles, { adx_len: 14, er_len: 10, threshold });

        const isResonant = macroMCI.mci > 0.60 && triggerMCI.mci >= threshold;

        const scanEntry = {
          asset,
          macro_mci: macroMCI.mci,
          trigger_mci: triggerMCI.mci,
          status: isResonant ? "RESONANT" : "STABLE"
        };
        
        results.push(scanEntry);
        await supabase.from('scan_results').insert([scanEntry]);

        if (isResonant) {
          const side = triggerMCI.di_plus > triggerMCI.di_minus ? 'LONG' : 'SHORT';
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers.host;
          
          // 3. Send the execution payload WITH tracking variables
          await fetch(`${protocol}://${host}/api/execute-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: asset.replace('-', ''),
              side,
              price: triggerCandles[triggerCandles.length - 1].close,
              mci: triggerMCI.mci,
              strategy_id: config.strategy,
              version: config.version || 'v1.0',
              execution_mode: config.execution_mode
            })
          });
        }
      } catch (assetErr) {
        console.error(`[ASSET ERROR] ${asset}:`, assetErr.message);
      }
    }

    return res.status(200).json({ status: "Dynamic Scan Complete", results });
  } catch (err) {
    console.error("[GLOBAL SCAN FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
  const path = `/api/v3/brokerage/products/${asset}/candles`;
  const end = Math.floor(Date.now() / 1000);
  const lookbackHours = granularity === 'ONE_HOUR' ? 48 : 20;
  const start = end - (3600 * lookbackHours); 
  const query = `?start=${start}&end=${end}&granularity=${granularity}`;

  const token = jwt.sign({
    iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
    sub: apiKey, uri: `GET api.coinbase.com${path}`,
  }, secret, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

  const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok || !data.candles || data.candles.length === 0) return null;

  return data.candles.map(c => ({ 
      close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low) 
  })).reverse();
}