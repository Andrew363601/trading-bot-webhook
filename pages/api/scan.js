// Unleashing Vercel Pro limit (5 full minutes) for mass strategy scanning
export const maxDuration = 300;

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
          telemetry: decision.telemetry || {},
          status: decision.signal ? "RESONANT" : "STABLE"
        };
        
        // Push to the cron log 
        results.push(scanEntry);
        
        // Insert into Supabase so the UI streams it
        await supabase.from('scan_results').insert([scanEntry]);
// 4. THE EXECUTION TRIGGER
if (decision.signal) {
  const tradePayload = {
      symbol: asset, 
      strategy_id: config.strategy, 
      version: config.version || 'v1.0',
      side: decision.signal,
      price: decision.entryPrice,
      tp_price: decision.tpPrice,
      sl_price: decision.slPrice,
      execution_mode: config.execution_mode || 'PAPER'
  };
  
  // Route it to your actual execution engine instead of bypassing it!
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const baseUrl = `${protocol}://${host}`;
  
  await fetch(`${baseUrl}/api/execute-trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradePayload)
  });
  
  console.log(`[TRADE ROUTED] ${decision.signal} on ${asset} via ${config.strategy}`);

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
    const safeGranularity = (granularity || 'ONE_HOUR').toUpperCase().replace(' ', '_');
    
    // --- THE PERPETUAL FUTURES FIX ---
    // Safely parse Spot vs Perp symbols without destroying hyphens
    let coinbaseProduct = asset.toUpperCase().trim();
    if (!coinbaseProduct.includes('-')) {
        if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
        else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
        else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP-INTX');
    } 
    if (coinbaseProduct.endsWith('-PERP')) {
        coinbaseProduct = coinbaseProduct + '-INTX';
    }
    
    const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
    const end = Math.floor(Date.now() / 1000);
    
    // Dynamic Lookback Calculation (Respecting the 300 Coinbase limit)
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

    const token = jwt.sign({
      iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey, uri: `GET api.coinbase.com${path}`,
    }, secret, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

    const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await resp.json();
    
    if (!resp.ok) {
        console.error(`[COINBASE API REJECTED] ${coinbaseProduct} | ${safeGranularity} | Status: ${resp.status}`, data);
        return null;
    }

    if (!data.candles || data.candles.length === 0) {
        console.error(`[COINBASE EMPTY CANDLES] ${coinbaseProduct} | ${safeGranularity} | Data:`, data);
        return null;
    }

    return data.candles.map(c => ({ 
        close: parseFloat(c.close), 
        high: parseFloat(c.high), 
        low: parseFloat(c.low),
        volume: parseFloat(c.volume)
    })).reverse();

  } catch (err) {
    console.error(`[FETCH FATAL ERROR] ${asset}:`, err.message);
    return null;
  }
}