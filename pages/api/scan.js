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

        // --- FETCH MICROSTRUCTURE & ORDER BOOK ---
        const microstructure = await fetchMicrostructure(asset, triggerCandles, apiKeyName, apiSecret);

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

        // --- SCOPE LIFT FOR PRE-EMPTIVE SWEEP ---
        let activePosition = null;
        let openOrders = [];

        // --- THE WATCHDOG, SWEEPER & NATIVE SYNC ---
        if (openTrade) {
            let coinbaseProduct = asset.toUpperCase().trim();
            if (!coinbaseProduct.includes('-')) {
                if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
            }

            if (config.execution_mode === 'LIVE') {
                try {
                    const posPath = '/api/v3/brokerage/cfm/positions';
                    const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
                    
                    const [posResp, orderResp] = await Promise.all([
                        fetch(`https://api.coinbase.com${posPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', posPath, apiKeyName, apiSecret)}` } }),
                        fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', orderPath, apiKeyName, apiSecret)}` } })
                    ]);

                    if (posResp.ok) {
                        const posData = await posResp.json();
                        activePosition = posData.positions?.find(p => p.product_id === coinbaseProduct && parseFloat(p.number_of_contracts) > 0);
                    }
                    if (orderResp.ok) {
                        const orderData = await orderResp.json();
                        openOrders = orderData.orders || [];
                    }

                    const entryOrderExists = openOrders.some(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));

                    // SCENARIO 0: Native Exchange Sync
                    if (!activePosition && !entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 2) {
                            console.log(`[SYNC] Trade ${openTrade.id} missing from Coinbase. Syncing native close...`);
                            
                            if (openOrders.length > 0) {
                                console.log(`[SWEEPER] Nuking ${openOrders.length} orphaned brackets for ${coinbaseProduct} to prevent Phantom Flips...`);
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, {
                                    method: 'POST', 
                                    headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, 
                                    body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) })
                                });
                            }

                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: EXCHANGE_NATIVE_CLOSE` : 'EXCHANGE_NATIVE_CLOSE';
                            await supabase.from('trade_logs').update({
                                exit_price: currentPrice, 
                                pnl: (openTrade.side === 'BUY' ? currentPrice - openTrade.entry_price : openTrade.entry_price - currentPrice) * openTrade.qty,
                                exit_time: new Date().toISOString(),
                                reason: updatedReason
                            }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO A: Stale Limit Sweeper
                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        
                        if (minutesOpen > 15) {
                            console.log(`[SWEEPER] Stale limit order detected for ${coinbaseProduct} (${minutesOpen.toFixed(1)} mins old). Canceling...`);
                            
                            const targetOrder = openOrders.find(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));
                            
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, {
                                    method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] })
                                });
                            }
                            
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                            await supabase.from('trade_logs').update({
                                exit_price: openTrade.entry_price, 
                                pnl: 0,
                                exit_time: new Date().toISOString(),
                                reason: updatedReason
                            }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO B: Bracket Deployment & Manual Sync
                    if (activePosition) {
                        const physicalTP = openOrders.find(o => o.order_configuration?.limit_limit_gtc);
                        const physicalSL = openOrders.find(o => o.order_configuration?.stop_limit_stop_limit_gtc);
                        
                        const physicalBracket = openOrders.find(o => o.order_configuration?.trigger_bracket_gtc);

                        if (physicalBracket && (!openTrade.tp_price || !openTrade.sl_price)) {
                             console.log(`[SYNC] Manual OCO Bracket detected on Coinbase UI for ${asset}. Updating database...`);
                             const updates = {
                                 tp_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.limit_price),
                                 sl_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.stop_trigger_price)
                             };
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price;
                             openTrade.sl_price = updates.sl_price;
                        } 
                        else if ((physicalTP && !openTrade.tp_price) || (physicalSL && !openTrade.sl_price)) {
                             console.log(`[SYNC] Manual individual brackets detected on Coinbase for ${asset}. Updating database...`);
                             const updates = {};
                             if (physicalTP) updates.tp_price = parseFloat(physicalTP.order_configuration.limit_limit_gtc.limit_price);
                             if (physicalSL) updates.sl_price = parseFloat(physicalSL.order_configuration.stop_limit_stop_limit_gtc.stop_price);
                             
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price || openTrade.tp_price;
                             openTrade.sl_price = updates.sl_price || openTrade.sl_price;
                        }

                        const hasTP = physicalBracket || physicalTP;
                        const hasSL = physicalBracket || physicalSL;

                        if (hasTP && hasSL) {
                            openTrade.skipVirtualEnforcer = true;
                        }

                        const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                        const stopDir = openTrade.side === 'BUY' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';
                        const orderQty = activePosition.number_of_contracts;
                        const executePath = '/api/v3/brokerage/orders';

                        let tickSize = 0.01;
                        if (coinbaseProduct.includes('ETP') || coinbaseProduct.includes('ETH')) tickSize = 0.50;
                        if (coinbaseProduct.includes('BIT') || coinbaseProduct.includes('BTC')) tickSize = 1.00;

                        const safeSlPrice = openTrade.sl_price ? (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(2) : null;
                        const safeTpPrice = openTrade.tp_price ? (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(2) : null;

                        // --- THE ULTIMATE FIX: OCO BRACKET DEPLOYMENT ---
                        if (!hasTP && !hasSL && safeTpPrice && safeSlPrice) {
                            console.log(`[WATCHDOG] Missing Brackets detected for ${coinbaseProduct}. Deploying Unified OCO (TP: $${safeTpPrice}, SL: $${safeSlPrice})...`);
                            try {
                                const ocoPayload = {
                                    client_order_id: `nx_oco_wd_${Date.now()}`,
                                    product_id: coinbaseProduct,
                                    side: closingSide,
                                    order_configuration: { 
                                        trigger_bracket_gtc: { 
                                            limit_price: safeTpPrice.toString(), 
                                            stop_trigger_price: safeSlPrice.toString(), 
                                            base_size: orderQty.toString() 
                                        } 
                                    }
                                };

                                const resp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                const result = await resp.json();
                                if (!resp.ok || result.success === false) console.error(`[WATCHDOG REJECT] OCO Failed:`, JSON.stringify(result));
                            } catch (e) { console.error(`[WATCHDOG FATAL] OCO:`, e.message); }
                        } 
                        else {
                            // FALLBACK: INDIVIDUAL LEGS
                            if (!hasSL && safeSlPrice) {
                                console.log(`[WATCHDOG] Missing Stop Loss detected for ${coinbaseProduct}. Deploying at $${safeSlPrice}...`);
                                try {
                                    const slPayload = {
                                        client_order_id: `nx_sl_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { 
                                            stop_limit_stop_limit_gtc: { stop_direction: stopDir, stop_price: safeSlPrice.toString(), limit_price: safeSlPrice.toString(), base_size: orderQty.toString(), reduce_only: true } 
                                        }
                                    };
                                    const resp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(slPayload) });
                                } catch (e) { console.error(`[WATCHDOG FATAL] SL:`, e.message); }
                            }

                            if (!hasTP && safeTpPrice) {
                                console.log(`[WATCHDOG] Missing Take Profit detected for ${coinbaseProduct}. Deploying at $${safeTpPrice}...`);
                                try {
                                    const tpPayload = {
                                        client_order_id: `nx_tp_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { 
                                            limit_limit_gtc: { limit_price: safeTpPrice.toString(), base_size: orderQty.toString(), reduce_only: true } 
                                        }
                                    };
                                    const resp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tpPayload) });
                                } catch (e) { console.error(`[WATCHDOG FATAL] TP:`, e.message); }
                            }
                        }
                    }

                } catch (err) { console.error(`[WATCHDOG FAULT]`, err.message); }
            }
        }

        // --- THE ORACLE EMERGENCY CHECK (-8% Pain Threshold) ---
        if (openTrade && !forcedExit) {
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') 
                ? (currentPrice - entryPrice) / entryPrice 
                : (entryPrice - currentPrice) / entryPrice;

            if (pnlPercent <= -0.08) { 
                console.log(`[ORACLE INITIATED] Emergency scan for ${asset}. Down ${(pnlPercent * 100).toFixed(2)}%`);
                const oracleVerdict = await evaluateTradeIdea({
                    mode: 'EMERGENCY', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles,
                    indicators: microstructure.indicators,
                    orderBook: microstructure.orderBook,
                    derivativesData: microstructure.derivativesData,
                    pnlPercent
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
        if (openTrade && openTrade.sl_price && openTrade.tp_price && !forcedExit && !openTrade.skipVirtualEnforcer) {
            if (openTrade.side === 'BUY' || openTrade.side === 'LONG') {
                if (currentPrice <= openTrade.sl_price) { forcedExit = 'STOP_LOSS'; console.log(`[VIRTUAL ENFORCER] BUY Stop Loss hit! Price: $${currentPrice} <= SL: $${openTrade.sl_price}`); }
                else if (currentPrice >= openTrade.tp_price) { forcedExit = 'TAKE_PROFIT'; console.log(`[VIRTUAL ENFORCER] BUY Take Profit hit! Price: $${currentPrice} >= TP: $${openTrade.tp_price}`); }
            } else {
                if (currentPrice >= openTrade.sl_price) { forcedExit = 'STOP_LOSS'; console.log(`[VIRTUAL ENFORCER] SELL Stop Loss hit! Price: $${currentPrice} >= SL: $${openTrade.sl_price}`); }
                else if (currentPrice <= openTrade.tp_price) { forcedExit = 'TAKE_PROFIT'; console.log(`[VIRTUAL ENFORCER] SELL Take Profit hit! Price: $${currentPrice} <= TP: $${openTrade.tp_price}`); }
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
       else if (decision.signal) {
        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
        decision.signal = normalizedSignal; 
        
        const isReversal = openTrade && openTrade.side !== normalizedSignal;
        const isDuplicate = openTrade && !isReversal;

        if (isDuplicate) {
            decision.signal = null;
        } else {
            console.log(`[ORACLE INITIATED] Scoring ${isReversal ? 'REVERSAL' : 'ENTRY'} ${decision.signal} signal for ${asset}...`);
            
            let currentTradeContext = null;
            if (isReversal) {
                const entry = parseFloat(openTrade.entry_price);
                const pnl = openTrade.side === 'BUY' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
                currentTradeContext = {
                    side: openTrade.side, entry_price: entry, pnl_percent: (pnl * 100).toFixed(2)
                };
            }

            const oracleVerdict = await evaluateTradeIdea({
                mode: isReversal ? 'REVERSAL' : 'ENTRY', asset, strategy: config.strategy, signal: decision.signal, 
                currentPrice, candles: triggerCandles, macroCandles: macroCandles, 
                indicators: microstructure.indicators,
                orderBook: microstructure.orderBook,
                derivativesData: microstructure.derivativesData,
                marketType: config.parameters?.market_type || 'FUTURES', openTrade: currentTradeContext
            });

            decision.telemetry = { ...decision.telemetry, oracle_score: oracleVerdict.conviction_score, oracle_reasoning: oracleVerdict.reasoning };

            if (oracleVerdict.action === 'VETO') {
                console.log(`[ORACLE VETO] Signal rejected. Score: ${oracleVerdict.conviction_score}. Reasoning: ${oracleVerdict.reasoning}`);
                decision.signal = null; 
                decision.statusOverride = 'ORACLE VETO'; 
            } else {
                console.log(`[ORACLE APPROVED] Score: ${oracleVerdict.conviction_score}. Mutating to LIMIT order at $${oracleVerdict.limit_price}. Size Multiplier: ${oracleVerdict.size_multiplier}x`);
                decision.entryPrice = oracleVerdict.limit_price; 
                decision.orderType = 'LIMIT';
                
                if (oracleVerdict.tp_price && oracleVerdict.sl_price) {
                    decision.tpPrice = oracleVerdict.tp_price;
                    decision.slPrice = oracleVerdict.sl_price;
                } else if (decision.tpPrice && decision.slPrice) {
                  const originalEntry = currentPrice;
                  const tpDistance = decision.tpPrice - originalEntry;
                  const slDistance = originalEntry - decision.slPrice;
                  decision.tpPrice = decision.entryPrice + (normalizedSignal === 'BUY' ? Math.abs(tpDistance) : -Math.abs(tpDistance));
                  decision.slPrice = decision.entryPrice - (normalizedSignal === 'BUY' ? Math.abs(slDistance) : -Math.abs(slDistance));
                } else {
                  const slP = config.parameters?.sl_percent || 0.01;
                  const tpP = config.parameters?.tp_percent || 0.02;
                  decision.tpPrice = normalizedSignal === 'BUY' ? decision.entryPrice * (1 + tpP) : decision.entryPrice * (1 - tpP);
                  decision.slPrice = normalizedSignal === 'BUY' ? decision.entryPrice * (1 - slP) : decision.entryPrice * (1 + slP);
                }
             
                let tickSize = 0.01;
                if (asset.includes('ETP') || asset.includes('ETH')) tickSize = 0.50;
                if (asset.includes('BIT') || asset.includes('BTC')) tickSize = 1.00;

                decision.tpPrice = Math.round(decision.tpPrice / tickSize) * tickSize;
                decision.slPrice = Math.round(decision.slPrice / tickSize) * tickSize;
                
                if (oracleVerdict.size_multiplier > 1.0 && config.parameters?.target_usd) {
                     config.parameters.target_usd = config.parameters.target_usd * oracleVerdict.size_multiplier;
                }
            }
        }
    }

    const finalStatus = decision.statusOverride ? decision.statusOverride : (decision.signal ? (forcedExit ? `HIT_${forcedExit}` : "RESONANT") : "STABLE");

    const scanEntry = { strategy: config.strategy, asset, telemetry: decision.telemetry || {}, status: finalStatus };
    results.push(scanEntry);
    await supabase.from('scan_results').insert([scanEntry]);

        if (decision.signal && decision.signal !== null) {
          
          // --- THE PRE-EMPTIVE CLEARING SWEEP ---
          const isExecutingReversal = openTrade && openTrade.side !== decision.signal;
          
          if (isExecutingReversal && config.execution_mode === 'LIVE' && openOrders.length > 0) {
              console.log(`[PRE-EMPTIVE SWEEP] Clearing ${openOrders.length} resting brackets before executing AI reversal...`);
              
              let coinbaseProduct = asset.toUpperCase().trim();
              if (!coinbaseProduct.includes('-')) {
                  if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                  else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                  else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
              }
              
              const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
              await fetch(`https://api.coinbase.com${cancelPath}`, {
                  method: 'POST', 
                  headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) })
              });
          }
          
          let finalQty = config.parameters?.qty || 10; 
          if (config.parameters?.target_usd && decision.entryPrice) {
              finalQty = config.parameters.target_usd / decision.entryPrice;
          }
          
          const tradePayload = {
              symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: decision.signal,
              order_type: decision.orderType || 'MARKET', price: decision.entryPrice, tp_price: decision.tpPrice || null,
              sl_price: decision.slPrice || null, execution_mode: config.execution_mode || 'PAPER', leverage: decision.leverage || 1,
              market_type: decision.marketType || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)),
              reason: decision.telemetry?.oracle_reasoning || decision.telemetry?.exit_reason || null 
          };
          
          const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
          const protocol = host.includes('localhost') ? 'http' : 'https';
          
          await fetch(`${protocol}://${host}/api/execute-trade`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tradePayload)
          });
        }

      } catch (assetErr) { console.error(`[ASSET ERROR] ${asset}:`, assetErr.message); }
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

    const privateKey = crypto.createPrivateKey({ key: secret, format: 'pem' });
    const token = jwt.sign({
      iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey, uri: `GET api.coinbase.com${path}`,
    }, privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

    const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await resp.json();
    
    if (!resp.ok) { return null; }
    if (!data.candles || data.candles.length === 0) { return null; }

    return data.candles.map(c => ({ close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();

  } catch (err) { return null; }
}

async function fetchMicrostructure(asset, triggerCandles, apiKey, secret) {
    try {
        // 1. Calculate VWAP and ATR locally from the trigger candles (No API calls required!)
        let typicalPriceVolume = 0;
        let totalVolume = 0;
        let trueRanges = [];
        
        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i];
            const prev = triggerCandles[i-1];
            
            // VWAP Math
            const typicalPrice = (c.high + c.low + c.close) / 3;
            typicalPriceVolume += typicalPrice * c.volume;
            totalVolume += c.volume;
            
            // ATR Math
            const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
            trueRanges.push(tr);
        }
        
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;

        return {
            indicators: { current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2) },
            orderBook: { status: "REST Level 2 Restricted for CDE Futures. Using VWAP/ATR routing." },
            derivativesData: { status: "Active" }
        };
    } catch (e) {
        console.error("[MICROSTRUCTURE FAULT]:", e.message);
        return { indicators: {}, orderBook: {}, derivativesData: {} };
    }
}