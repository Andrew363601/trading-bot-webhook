// Unleashing Vercel Pro limit (5 full minutes) for mass strategy scanning
export const maxDuration = 300;

// pages/api/scan.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateStrategy } from '../../lib/strategy-router.js';
import { evaluateTradeIdea } from '../../lib/trade-oracle.js'; // NEW: The Oracle

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
        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        const [macroCandles, triggerCandles] = await Promise.all([
          fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
          fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
        ]);

        if (!macroCandles || !triggerCandles || macroCandles.length < 21 || triggerCandles.length < 21) continue;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        // FETCH OPEN TRADES
        const { data: openTrades } = await supabase
            .from('trade_logs')
            .select('*')
            .eq('symbol', asset)
            .eq('strategy_id', config.strategy)
            .is('exit_price', null)
            .order('id', { ascending: false })
            .limit(1);
        
        const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;
        let forcedExit = null;

        // --- NEW: THE ORACLE EMERGENCY CHECK (-8% Pain Threshold) ---
        if (openTrade) {
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') 
                ? (currentPrice - entryPrice) / entryPrice 
                : (entryPrice - currentPrice) / entryPrice;

            if (pnlPercent <= -0.08) { // If down 8%
                console.log(`[ORACLE INITIATED] Emergency scan for ${asset}. Down ${(pnlPercent * 100).toFixed(2)}%`);
                const oracleVerdict = await evaluateTradeIdea({
                    mode: 'EMERGENCY', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, pnlPercent
                });

                if (oracleVerdict.action === 'MARKET_CLOSE') {
                    console.log(`[ORACLE VETO] Structural failure detected. Forcing close on ${asset}. Reasoning: ${oracleVerdict.reasoning}`);
                    forcedExit = 'ORACLE_EMERGENCY_CLOSE';
                }
            }
        }

        // Evaluate Strategy Logic
        const marketData = { macro: macroCandles, trigger: triggerCandles };
        let decision = await evaluateStrategy(config.strategy, marketData, config.parameters);
        if (decision.error) continue;

        // VIRTUAL TP/SL ENFORCER
        if (openTrade && openTrade.sl_price && openTrade.tp_price && !forcedExit) {
            if (openTrade.side === 'BUY' || openTrade.side === 'LONG') {
                if (currentPrice <= openTrade.sl_price) forcedExit = 'STOP_LOSS';
                else if (currentPrice >= openTrade.tp_price) forcedExit = 'TAKE_PROFIT';
            } else {
                if (currentPrice >= openTrade.sl_price) forcedExit = 'STOP_LOSS';
                else if (currentPrice <= openTrade.tp_price) forcedExit = 'TAKE_PROFIT';
            }
        }

        // FORCE CLOSE OVERRIDE
        if (forcedExit) {
            decision.signal = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? 'SELL' : 'BUY';
            decision.entryPrice = currentPrice;
            decision.orderType = 'MARKET'; // Emergencies and stops are always Market orders
            decision.tpPrice = null; 
            decision.slPrice = null;
            decision.telemetry = { ...decision.telemetry, exit_reason: forcedExit };
        } 
        
       // --- NEW: THE ORACLE LIMIT ORDER INTERCEPTOR ---
       else if (decision.signal && !openTrade) {
        // A new trade wants to open. Pause and ask the Oracle.
        console.log(`[ORACLE INITIATED] Scoring ${decision.signal} signal for ${asset}...`);
        
        const oracleVerdict = await evaluateTradeIdea({
            mode: 'ENTRY', 
            asset, 
            strategy: config.strategy, 
            signal: decision.signal, 
            currentPrice, 
            candles: triggerCandles,
            marketType: config.parameters?.market_type || 'FUTURES' 
        });

        // 1. THE FIX: Attach the Oracle's logic to the telemetry IMMEDIATELY, before the if/else block
        decision.telemetry = { 
            ...decision.telemetry, 
            oracle_score: oracleVerdict.conviction_score, 
            oracle_reasoning: oracleVerdict.reasoning 
        };

        if (oracleVerdict.action === 'VETO') {
            console.log(`[ORACLE VETO] Signal rejected. Score: ${oracleVerdict.conviction_score}. Reasoning: ${oracleVerdict.reasoning}`);
            decision.signal = null; // Kill the trade execution
            decision.statusOverride = 'ORACLE VETO'; // Flag it for the UI dashboard
        } else {
            console.log(`[ORACLE APPROVED] Score: ${oracleVerdict.conviction_score}. Mutating to LIMIT order at $${oracleVerdict.limit_price}. Size Multiplier: ${oracleVerdict.size_multiplier}x`);
            
            // Mutate the payload to the Oracle's optimized specs
            decision.entryPrice = oracleVerdict.limit_price; // Snipe the pullback
            decision.orderType = 'LIMIT';
            
            // Recalculate TP/SL based on the NEW optimized limit price
            const slP = config.parameters?.sl_percent || 0.01;
            const tpP = config.parameters?.tp_percent || 0.02;
            decision.tpPrice = decision.signal === 'BUY' ? decision.entryPrice * (1 + tpP) : decision.entryPrice * (1 - tpP);
            decision.slPrice = decision.signal === 'BUY' ? decision.entryPrice * (1 - slP) : decision.entryPrice * (1 + slP);
            
            // Apply Conviction Sizing using the updated size_multiplier
            if (oracleVerdict.size_multiplier > 1.0 && config.parameters?.target_usd) {
                 config.parameters.target_usd = config.parameters.target_usd * oracleVerdict.size_multiplier;
            }
        }
    }

    // 2. THE UI FLAG: We update how the scanEntry determines its status
    const finalStatus = decision.statusOverride 
        ? decision.statusOverride 
        : (decision.signal ? (forcedExit ? `HIT_${forcedExit}` : "RESONANT") : "STABLE");

    const scanEntry = {
      strategy: config.strategy,
      asset,
      telemetry: decision.telemetry || {},
      status: finalStatus
    };
    
    results.push(scanEntry);
    await supabase.from('scan_results').insert([scanEntry]);
        
        results.push(scanEntry);
        await supabase.from('scan_results').insert([scanEntry]);

        // THE EXECUTION TRIGGER
        if (decision.signal) {
          let finalQty = config.parameters?.qty || 10; 
          if (config.parameters?.target_usd && decision.entryPrice) {
              finalQty = config.parameters.target_usd / decision.entryPrice;
          }

          const tradePayload = {
              symbol: asset, 
              strategy_id: config.strategy, 
              version: config.version || 'v1.0',
              side: decision.signal,
              order_type: decision.orderType || 'MARKET', // Explicitly declare LIMIT or MARKET
              price: decision.entryPrice,
              tp_price: decision.tpPrice || null,
              sl_price: decision.slPrice || null,
              execution_mode: config.execution_mode || 'PAPER',
              leverage: decision.leverage || 1,
              market_type: decision.marketType || 'FUTURES',
              qty: parseFloat(finalQty.toFixed(2)),
              reason: decision.telemetry?.oracle_reasoning || decision.telemetry?.exit_reason || null 
          };
          
          const protocol = req.headers['x-forwarded-proto'] || 'http';
          const host = req.headers.host;
          await fetch(`${protocol}://${host}/api/execute-trade`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(tradePayload)
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