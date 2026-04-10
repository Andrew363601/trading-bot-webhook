// pages/api/scan.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateStrategy } from '../../lib/strategy-router.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    const { data: activeConfigs, error: configErr } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('is_active', true);

    if (configErr) throw new Error(configErr.message);
    if (!activeConfigs || activeConfigs.length === 0) {
        return res.status(200).json({ status: "No active strategies to scan." });
    }

    for (const config of activeConfigs) {
      const asset = config.asset;
      if (!asset) continue;

      try {
        // 1. Read Dynamic Timeframes from the DB (Fallback to 1H/5M if not set)
        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        // 2. Concurrently fetch the exact timeframes requested by the strategy
        const [macroCandles, triggerCandles] = await Promise.all([
            fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
            fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
        ]);

        if (!macroCandles || macroCandles.length < 31 || !triggerCandles || triggerCandles.length < 31) {
            results.push({ asset, strategy: config.strategy, status: "INSUFFICIENT_DATA" });
            continue;
        }

        // 3. Package data and route to the dynamic brain
        const marketData = { macro: macroCandles, trigger: triggerCandles };
        
        // ADD AWAIT HERE: The scanner must wait for the dynamic file to import and execute
        const decision = await evaluateStrategy(config.strategy, marketData, config.parameters);

        const scanEntry = {
          asset,
          macro_mci: decision.mci || 0,
          trigger_mci: decision.mci || 0,
          status: decision.signal ? "RESONANT" : "STABLE"
        };
        
        results.push(scanEntry);
        await supabase.from('scan_results').insert([scanEntry]);

        // 4. If the router returned a signal, fire the execution payload
        if (decision.signal) {
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers.host;
          
          await fetch(`${protocol}://${host}/api/execute-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: asset.replace('-', ''),
              side: decision.signal,
              price: decision.entryPrice,
              mci: decision.mci,
              strategy_id: config.strategy,
              version: config.version || 'v1.0',
              execution_mode: config.execution_mode,
              leverage: decision.leverage,
              market_type: decision.marketType,
              tp_price: decision.tpPrice,
              sl_price: decision.slPrice
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
  // FIX: Force the hyphen format so Coinbase API accepts it
  const coinbaseProduct = asset.includes('-') ? asset : asset.replace('USDT', '-USDT').replace('USD', '-USD');
  const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
  
  const end = Math.floor(Date.now() / 1000);
  
  // Calculate lookback dynamically based on the timeframe requested
  let lookbackSeconds;
  switch (granularity) {
      case 'ONE_MINUTE': lookbackSeconds = 60 * 60; break;          // 1 hour
      case 'FIVE_MINUTE': lookbackSeconds = 300 * 60; break;        // 5 hours
      case 'FIFTEEN_MINUTE': lookbackSeconds = 900 * 60; break;     // 15 hours
      case 'ONE_HOUR': lookbackSeconds = 3600 * 48; break;          // 48 hours
      case 'ONE_DAY': lookbackSeconds = 86400 * 45; break;          // 45 days
      default: lookbackSeconds = 3600 * 24;                         // Fallback 24h
  }
  
  const start = end - lookbackSeconds; 
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