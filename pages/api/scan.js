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

      // DIAGNOSTIC 1: Did the API fail completely?
      if (!macroCandles || !triggerCandles) {
          results.push({ 
              strategy: config.strategy, 
              asset, 
              status: "API_FETCH_FAILED", 
              details: "Coinbase rejected the request. Check Vercel logs for the 400/401 error." 
          });
          continue;
      }

      // DIAGNOSTIC 2: Did it return data, but not enough?
      if (macroCandles.length < 21 || triggerCandles.length < 21) {
          results.push({ 
              strategy: config.strategy, 
              asset, 
              status: "INSUFFICIENT_DATA",
              macro_candles_received: macroCandles.length,
              trigger_candles_received: triggerCandles.length
          });
          continue;
      }

      // 3. Package data and route to the dynamic brain
      const marketData = { macro: macroCandles, trigger: triggerCandles };
      const decision = await evaluateStrategy(config.strategy, marketData, config.parameters);

      // DIAGNOSTIC 3: Did the Dynamic Router fail to find your .js file?
      if (decision.error) {
          results.push({
              strategy: config.strategy,
              asset,
              status: "ROUTER_ERROR",
              details: decision.error
          });
          continue;
      }

      // The database payload (matches your Supabase columns exactly)
      const scanEntry = {
        strategy: config.strategy,
        asset,
        macro_mci: decision.mci || 0,
        trigger_mci: decision.mci || 0,
        status: decision.signal ? "RESONANT" : "STABLE"
      };
      
      // Push to the cron log WITH the strategy name so you can read it!
      results.push({ strategy: config.strategy, ...scanEntry });
      
      // Insert into Supabase so the UI streams it
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
  try {
    // 1. Bulletproof the inputs
    const safeGranularity = (granularity || 'ONE_HOUR').toUpperCase().replace(' ', '_');
    
// THE ULTIMATE HYPHEN FIX (Corrected)
const cleanAsset = asset.replace(/-/g, '');
const coinbaseProduct = cleanAsset.replace(/(USDT|USD)$/, '-$1');
const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
    
    const end = Math.floor(Date.now() / 1000);
    
    // 2. Dynamic Lookback Calculation
    let lookbackSeconds;
    switch (safeGranularity) {
        case 'ONE_MINUTE': lookbackSeconds = 60 * 300; break;          
        case 'FIVE_MINUTE': lookbackSeconds = 300 * 300; break;        
        case 'FIFTEEN_MINUTE': lookbackSeconds = 900 * 300; break;     
        case 'ONE_HOUR': lookbackSeconds = 3600 * 300; break;          
        case 'ONE_DAY': lookbackSeconds = 86400 * 300; break;          
        default: lookbackSeconds = 3600 * 300;                         
    }
    
    const start = end - lookbackSeconds; 
    const query = `?start=${start}&end=${end}&granularity=${safeGranularity}`;

    // 3. Token Generation
    const token = jwt.sign({
      iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey, uri: `GET api.coinbase.com${path}`,
    }, secret, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

    // 4. The Request
    const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await resp.json();
    
    // --- THE DIAGNOSTIC LOGS ---
    if (!resp.ok) {
        console.error(`[COINBASE API REJECTED] ${coinbaseProduct} | ${safeGranularity} | Status: ${resp.status}`, data);
        return null;
    }

    if (!data.candles || data.candles.length === 0) {
        console.error(`[COINBASE EMPTY CANDLES] ${coinbaseProduct} | ${safeGranularity} | Data:`, data);
        return null;
    }

    // 5. Clean output
    return data.candles.map(c => ({ 
        close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low) 
    })).reverse();

  } catch (err) {
    console.error(`[FETCH FATAL ERROR] ${asset}:`, err.message);
    return null;
  }
}