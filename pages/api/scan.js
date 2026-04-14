// Unleashing Vercel Pro limit (5 full minutes) for mass strategy scanning
export const maxDuration = 300;

// pages/api/scan.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateStrategy } from '../../lib/strategy-router.js';
import { evaluateTradeIdea } from '../../lib/trade-oracle.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper function for the Watchdog to sign Coinbase API requests
function generateCoinbaseToken(method, path, apiKey, apiSecret) {
  const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
  // THE FIX: Strip query parameters out of the URI before signing
  const uriPath = path.split('?')[0]; 
  return jwt.sign(
      { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
      privateKey,
      { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
  );
}

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

        // --- NEW: THE LIMIT ORDER WATCHDOG (EXCHANGE SYNC) ---
        if (openTrade && config.execution_mode === 'LIVE' && openTrade.tp_price && openTrade.sl_price) {
            try {
                let coinbaseProduct = asset.toUpperCase().trim();
                if (!coinbaseProduct.includes('-')) {
                    if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                    else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                    else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
                }

                // 1. Check if the Limit Order actually filled and became a live position
                const posPath = '/api/v3/brokerage/cfm/positions';
                const posToken = generateCoinbaseToken('GET', posPath, apiKeyName, apiSecret);
                const posResp = await fetch(`https://api.coinbase.com${posPath}`, { headers: { 'Authorization': `Bearer ${posToken}` } });
                
                if (posResp.ok) {
                    const posData = await posResp.json();
                    const activePosition = posData.positions?.find(p => p.product_id === coinbaseProduct && parseFloat(p.number_of_contracts) > 0);

                    if (activePosition) {
                        // 2. Position is live. Check if TP/SL brackets are already deployed
                        const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
                        const orderToken = generateCoinbaseToken('GET', orderPath, apiKeyName, apiSecret);
                        const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${orderToken}` } });
                        
                        if (orderResp.ok) {
                            const orderData = await orderResp.json();
                            
                            // If no open orders exist, the limit filled but the brackets are missing. Deploy them!
                            if (!orderData.orders || orderData.orders.length === 0) {
                                console.log(`[WATCHDOG] Detected active position for ${coinbaseProduct} with missing brackets. Deploying TP/SL...`);
                                
                                const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                                const stopDir = openTrade.side === 'BUY' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';
                                const orderQty = activePosition.number_of_contracts;
                                const executePath = '/api/v3/brokerage/orders';
                                
                                // Fire Stop Loss Bracket
                                try {
                                    const slPayload = {
                                        client_order_id: `nx_sl_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { stop_limit_stop_limit_gtc: { stop_direction: stopDir, stop_price: openTrade.sl_price.toString(), limit_price: openTrade.sl_price.toString(), base_size: orderQty.toString() } }
                                    };
                                    await fetch(`https://api.coinbase.com${executePath}`, {
                                        method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(slPayload)
                                    });
                                } catch (e) { console.error("[WATCHDOG] SL Bracket failed:", e.message); }

                                // Fire Take Profit Bracket
                                try {
                                    const tpPayload = {
                                        client_order_id: `nx_tp_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { limit_limit_gtc: { limit_price: openTrade.tp_price.toString(), base_size: orderQty.toString() } }
                                    };
                                    await fetch(`https://api.coinbase.com${executePath}`, {
                                        method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tpPayload)
                                    });
                                } catch (e) { console.error("[WATCHDOG] TP Bracket failed:", e.message); }
                            }
                        }
                    }
                }
            } catch (err) { console.error(`[WATCHDOG FAULT]`, err.message); }
        }

        // --- THE ORACLE EMERGENCY CHECK (-8% Pain Threshold) ---
        if (openTrade) {
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') 
                ? (currentPrice - entryPrice) / entryPrice 
                : (entryPrice - currentPrice) / entryPrice;

            if (pnlPercent <= -0.08) { 
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

        // VIRTUAL TP/SL ENFORCER (Fallback for Paper Trading or un-bracketed limits)
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
            decision.orderType = 'MARKET'; 
            decision.tpPrice = null; 
            decision.slPrice = null;
            decision.telemetry = { ...decision.telemetry, exit_reason: forcedExit };
        } 
        
       // --- THE ORACLE LIMIT ORDER INTERCEPTOR ---
       else if (decision.signal && !openTrade) {
        console.log(`[ORACLE INITIATED] Scoring ${decision.signal} signal for ${asset}...`);
        
        const oracleVerdict = await evaluateTradeIdea({
            mode: 'ENTRY', asset, strategy: config.strategy, signal: decision.signal, currentPrice, candles: triggerCandles, marketType: config.parameters?.market_type || 'FUTURES' 
        });

        decision.telemetry = { 
            ...decision.telemetry, 
            oracle_score: oracleVerdict.conviction_score, 
            oracle_reasoning: oracleVerdict.reasoning 
        };

        if (oracleVerdict.action === 'VETO') {
            console.log(`[ORACLE VETO] Signal rejected. Score: ${oracleVerdict.conviction_score}. Reasoning: ${oracleVerdict.reasoning}`);
            decision.signal = null; 
            decision.statusOverride = 'ORACLE VETO'; 
        } else {
            console.log(`[ORACLE APPROVED] Score: ${oracleVerdict.conviction_score}. Mutating to LIMIT order at $${oracleVerdict.limit_price}. Size Multiplier: ${oracleVerdict.size_multiplier}x`);
            
            decision.entryPrice = oracleVerdict.limit_price; 
            decision.orderType = 'LIMIT';
            
            // --- NEW: THE TP/SL PASS-THROUGH ---
            // If the strategy calculated strict ATR targets, move them down/up to match the new limit entry
            if (decision.tpPrice && decision.slPrice) {
                 const originalEntry = currentPrice;
                 const tpDistance = decision.tpPrice - originalEntry;
                 const slDistance = originalEntry - decision.slPrice;
                 decision.tpPrice = decision.entryPrice + (decision.signal === 'BUY' ? Math.abs(tpDistance) : -Math.abs(tpDistance));
                 decision.slPrice = decision.entryPrice - (decision.signal === 'BUY' ? Math.abs(slDistance) : -Math.abs(slDistance));
            } else {
                 const slP = config.parameters?.sl_percent || 0.01;
                 const tpP = config.parameters?.tp_percent || 0.02;
                 decision.tpPrice = decision.signal === 'BUY' ? decision.entryPrice * (1 + tpP) : decision.entryPrice * (1 - tpP);
                 decision.slPrice = decision.signal === 'BUY' ? decision.entryPrice * (1 - slP) : decision.entryPrice * (1 + slP);
            }
            
            // Format to 6 decimals to prevent API rejections
            decision.tpPrice = parseFloat(decision.tpPrice.toFixed(6));
            decision.slPrice = parseFloat(decision.slPrice.toFixed(6));
            
            if (oracleVerdict.size_multiplier > 1.0 && config.parameters?.target_usd) {
                 config.parameters.target_usd = config.parameters.target_usd * oracleVerdict.size_multiplier;
            }
        }
    }

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
              order_type: decision.orderType || 'MARKET',
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
    
    let coinbaseProduct = asset.toUpperCase().trim();
    if (!coinbaseProduct.includes('-')) {
        if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
        else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
        else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
    }
    
    const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
    const end = Math.floor(Date.now() / 1000);
    
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

    // --- NEW: THE ES256 SECURE CRYPTO FIX ---
    const privateKey = crypto.createPrivateKey({ key: secret, format: 'pem' });
    const token = jwt.sign({
      iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey, uri: `GET api.coinbase.com${path}`,
    }, privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

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