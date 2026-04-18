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

    const { data: activeConfigs, error: configErr } = await supabase.from('strategy_config').select('*').eq('is_active', true);

    if (configErr) throw new Error(configErr.message);
    if (!activeConfigs || activeConfigs.length === 0) return res.status(200).json({ status: "No active strategies to scan." });

    for (const config of activeConfigs) {
      const asset = config.asset;
      if (!asset) continue;

      // --- 🛡️ DEFENSE 1: MUTEX LOCK (Race Condition Prevention) ---
      if (config.is_processing) {
          console.log(`[MUTEX LOCK] ${config.strategy} on ${asset} is currently processing a previous ping. Aborting to prevent double-fire.`);
          continue;
      }

      // Lock the strategy
      await supabase.from('strategy_config').update({ is_processing: true }).eq('strategy', config.strategy);

      try {
        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        const [macroCandles, triggerCandles] = await Promise.all([
          fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
          fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
        ]);

        if (!macroCandles || !triggerCandles || macroCandles.length < 21 || triggerCandles.length < 21) continue;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        const microstructure = await fetchMicrostructure(asset, triggerCandles, apiKeyName, apiSecret);

        const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', asset).eq('strategy_id', config.strategy).is('exit_price', null).order('id', { ascending: false }).limit(1);
        
        const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;
        let forcedExit = null;

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
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, {
                                    method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, 
                                    body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) })
                                });
                            }

                            let multiplier = 1.0;
                            if (coinbaseProduct.includes('ETP')) multiplier = 0.1;
                            if (coinbaseProduct.includes('BIT')) multiplier = 0.01;

                            let exactExitPrice = currentPrice;
                            let assumedReason = 'EXCHANGE_NATIVE_CLOSE';

                            if (openTrade.tp_price && openTrade.sl_price) {
                                const distToTp = Math.abs(currentPrice - openTrade.tp_price);
                                const distToSl = Math.abs(currentPrice - openTrade.sl_price);
                                if (distToTp < distToSl) { exactExitPrice = openTrade.tp_price; assumedReason = 'TAKE_PROFIT (NATIVE_SYNC)'; } 
                                else { exactExitPrice = openTrade.sl_price; assumedReason = 'STOP_LOSS (NATIVE_SYNC)'; }
                            }

                            const rawPnl = openTrade.side === 'BUY' ? (exactExitPrice - openTrade.entry_price) * openTrade.qty * multiplier : (openTrade.entry_price - exactExitPrice) * openTrade.qty * multiplier;
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${assumedReason}` : assumedReason;
                            
                            await supabase.from('trade_logs').update({ exit_price: exactExitPrice, pnl: parseFloat(rawPnl.toFixed(4)), exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO A: Stale Limit Sweeper
                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 15) {
                            const targetOrder = openOrders.find(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] }) });
                            }
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                            await supabase.from('trade_logs').update({ exit_price: openTrade.entry_price, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO B: Bracket Deployment & Manual Sync
                    if (activePosition) {
                        const physicalTP = openOrders.find(o => o.order_configuration?.limit_limit_gtc);
                        const physicalSL = openOrders.find(o => o.order_configuration?.stop_limit_stop_limit_gtc);
                        const physicalBracket = openOrders.find(o => o.order_configuration?.trigger_bracket_gtc);

                        if (physicalBracket && (!openTrade.tp_price || !openTrade.sl_price)) {
                             const updates = { tp_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.limit_price), sl_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.stop_trigger_price) };
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price; openTrade.sl_price = updates.sl_price;
                        } else if ((physicalTP && !openTrade.tp_price) || (physicalSL && !openTrade.sl_price)) {
                             const updates = {};
                             if (physicalTP) updates.tp_price = parseFloat(physicalTP.order_configuration.limit_limit_gtc.limit_price);
                             if (physicalSL) updates.sl_price = parseFloat(physicalSL.order_configuration.stop_limit_stop_limit_gtc.stop_price);
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price || openTrade.tp_price; openTrade.sl_price = updates.sl_price || openTrade.sl_price;
                        }

                        const hasTP = physicalBracket || physicalTP;
                        const hasSL = physicalBracket || physicalSL;

                        if (hasTP && hasSL) openTrade.skipVirtualEnforcer = true;

                        const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                        const orderQty = activePosition.number_of_contracts;
                        const executePath = '/api/v3/brokerage/orders';

                        let tickSize = (coinbaseProduct.includes('ETP') || coinbaseProduct.includes('ETH')) ? 0.50 : 0.01;
                        if (coinbaseProduct.includes('BIT') || coinbaseProduct.includes('BTC')) tickSize = 1.00;

                        const safeSlPrice = openTrade.sl_price ? (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(2) : null;
                        const safeTpPrice = openTrade.tp_price ? (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(2) : null;

                        // --- OCO BRACKET SANITY CHECK ---
                        if (!hasTP && !hasSL && safeTpPrice && safeSlPrice) {
                            let priceCrossed = false;
                            if (openTrade.side === 'BUY' && (currentPrice >= parseFloat(safeTpPrice) || currentPrice <= parseFloat(safeSlPrice))) priceCrossed = true;
                            if (openTrade.side === 'SELL' && (currentPrice <= parseFloat(safeTpPrice) || currentPrice >= parseFloat(safeSlPrice))) priceCrossed = true;

                            if (priceCrossed) {
                                console.log(`[WATCHDOG VETO] Price $${currentPrice} already crossed target bounds. Firing Market Close to prevent bracket rejection!`);
                                forcedExit = 'MISSED_BRACKET_MARKET_CLOSE';
                            } else {
                                console.log(`[WATCHDOG] Missing Brackets detected for ${coinbaseProduct}. Deploying Unified OCO (TP: $${safeTpPrice}, SL: $${safeSlPrice})...`);
                                try {
                                    const ocoPayload = {
                                        client_order_id: `nx_oco_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { trigger_bracket_gtc: { limit_price: safeTpPrice.toString(), stop_trigger_price: safeSlPrice.toString(), base_size: orderQty.toString() } }
                                    };
                                    await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                } catch (e) { console.error(`[WATCHDOG FATAL] OCO:`, e.message); }
                            }
                        } 
                    }
                } catch (err) { console.error(`[WATCHDOG FAULT]`, err.message); }
            }
        }

        // --- THE ORACLE EMERGENCY CHECK (-8% Pain Threshold) ---
        if (openTrade && !forcedExit) {
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

            if (pnlPercent <= -0.08) { 
                const oracleVerdict = await evaluateTradeIdea({ mode: 'EMERGENCY', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, pnlPercent });
                if (oracleVerdict.action === 'MARKET_CLOSE') forcedExit = 'ORACLE_EMERGENCY_CLOSE';
            }
        }

        const marketData = { macro: macroCandles, trigger: triggerCandles };
        let decision = await evaluateStrategy(config.strategy, marketData, config.parameters);
        if (decision.error) continue;

        if (openTrade && openTrade.sl_price && openTrade.tp_price && !forcedExit && !openTrade.skipVirtualEnforcer) {
            if (openTrade.side === 'BUY' || openTrade.side === 'LONG') {
                if (currentPrice <= openTrade.sl_price) forcedExit = 'STOP_LOSS'; 
                else if (currentPrice >= openTrade.tp_price) forcedExit = 'TAKE_PROFIT';
            } else {
                if (currentPrice >= openTrade.sl_price) forcedExit = 'STOP_LOSS';
                else if (currentPrice <= openTrade.tp_price) forcedExit = 'TAKE_PROFIT';
            }
        }

        if (forcedExit) {
            decision.signal = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? 'SELL' : 'BUY';
            decision.entryPrice = currentPrice;
            decision.orderType = 'MARKET'; 
            decision.tpPrice = null; decision.slPrice = null;
            decision.telemetry = { ...decision.telemetry, exit_reason: forcedExit };
        } 
       else if (decision.signal) {
        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
        decision.signal = normalizedSignal; 
        
        const isReversal = openTrade && openTrade.side !== normalizedSignal;
        const isDuplicate = openTrade && !isReversal;

        // --- 🛡️ DEFENSE 2: DYNAMIC ORACLE COOLDOWN (Chop Prevention) ---
        const cooldownMinutes = config.parameters?.veto_cooldown_minutes || 15; // Dynamic default to 15 mins
        const lastVetoTime = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
        const isCooldownActive = (Date.now() - lastVetoTime) < (cooldownMinutes * 60000);

        // We ONLY apply the cooldown if you have NO open trades. 
        // Reversals and emergencies always bypass this to protect your capital.
        if (isCooldownActive && !openTrade && !isReversal && !isDuplicate) {
            console.log(`[API DEFENSE] Skipping new entry ping for ${asset}. Oracle Veto cooldown active for ${cooldownMinutes} minutes.`);
            decision.signal = null;
            decision.statusOverride = `COOLDOWN (${cooldownMinutes}M)`;
        }

        if (isDuplicate) {
            decision.signal = null;
        } else if (decision.signal) {
            let currentTradeContext = null;
            if (isReversal) {
                const entry = parseFloat(openTrade.entry_price);
                const pnl = openTrade.side === 'BUY' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
                currentTradeContext = { side: openTrade.side, entry_price: entry, pnl_percent: (pnl * 100).toFixed(2) };
            }

            const oracleVerdict = await evaluateTradeIdea({
                mode: isReversal ? 'REVERSAL' : 'ENTRY', asset, strategy: config.strategy, signal: decision.signal, 
                currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators,
                orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, marketType: config.parameters?.market_type || 'FUTURES', openTrade: currentTradeContext
            });

            decision.telemetry = { ...decision.telemetry, oracle_score: oracleVerdict.conviction_score, oracle_reasoning: oracleVerdict.reasoning };

            if (oracleVerdict.action === 'VETO') {
                // Log the Veto time in Supabase to trigger the cooldown
                await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('strategy', config.strategy);
                decision.signal = null; decision.statusOverride = 'ORACLE VETO'; 
            } else {
                decision.entryPrice = oracleVerdict.limit_price; 
                decision.orderType = 'LIMIT';
                
                if (oracleVerdict.tp_price && oracleVerdict.sl_price) {
                    decision.tpPrice = oracleVerdict.tp_price; decision.slPrice = oracleVerdict.sl_price;
                } else if (decision.tpPrice && decision.slPrice) {
                  const tpDist = decision.tpPrice - currentPrice; const slDist = currentPrice - decision.slPrice;
                  decision.tpPrice = decision.entryPrice + (normalizedSignal === 'BUY' ? Math.abs(tpDist) : -Math.abs(tpDist));
                  decision.slPrice = decision.entryPrice - (normalizedSignal === 'BUY' ? Math.abs(slDist) : -Math.abs(slDist));
                } else {
                  const slP = config.parameters?.sl_percent || 0.01; const tpP = config.parameters?.tp_percent || 0.02;
                  decision.tpPrice = normalizedSignal === 'BUY' ? decision.entryPrice * (1 + tpP) : decision.entryPrice * (1 - tpP);
                  decision.slPrice = normalizedSignal === 'BUY' ? decision.entryPrice * (1 - slP) : decision.entryPrice * (1 + slP);
                }
             
                let tickSize = (asset.includes('ETP') || asset.includes('ETH')) ? 0.50 : 0.01;
                if (asset.includes('BIT') || asset.includes('BTC')) tickSize = 1.00;

                decision.tpPrice = Math.round(decision.tpPrice / tickSize) * tickSize;
                decision.slPrice = Math.round(decision.slPrice / tickSize) * tickSize;
                
                if (oracleVerdict.size_multiplier > 1.0 && config.parameters?.target_usd) config.parameters.target_usd = config.parameters.target_usd * oracleVerdict.size_multiplier;
            }
        }
    }

    const finalStatus = decision.statusOverride ? decision.statusOverride : (decision.signal ? (forcedExit ? `HIT_${forcedExit}` : "RESONANT") : "STABLE");
    const scanEntry = { strategy: config.strategy, asset, telemetry: decision.telemetry || {}, status: finalStatus };
    results.push(scanEntry);
    await supabase.from('scan_results').insert([scanEntry]);

    // --- RESTORED EXECUTION WRAPPER ---
    if (decision.signal && decision.signal !== null) {
        const isExecutingReversal = openTrade && openTrade.side !== decision.signal;
        let coinbaseProduct = asset.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) {
            if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
            else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
            else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
        }

        if (isExecutingReversal && config.execution_mode === 'LIVE' && openOrders.length > 0) {
            console.log(`[PRE-EMPTIVE SWEEP] Clearing ${openOrders.length} resting brackets before executing AI reversal...`);
            const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
            await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
            
            // 🛡️ THE BREATHER FIX: Force the bot to pause for 2.5 seconds to let the Coinbase Clearinghouse actually delete the brackets and release your margin.
            console.log(`[REVERSAL ENGINE] Pausing for 2.5 seconds for Coinbase margin clearing...`);
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
          
        let finalQty = config.parameters?.qty || 10; 
        if (config.parameters?.target_usd && decision.entryPrice) finalQty = config.parameters.target_usd / decision.entryPrice;
        
        const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
        const protocol = host.includes('localhost') ? 'http' : 'https';

        if (isExecutingReversal) {
            console.log(`[REVERSAL ENGINE] Step 1: Closing existing ${openTrade.side} position...`);
            const closePayload = {
                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: decision.signal,
                order_type: 'MARKET', price: currentPrice, tp_price: null, sl_price: null,
                execution_mode: config.execution_mode || 'PAPER', leverage: decision.leverage || 1,
                market_type: decision.marketType || 'FUTURES', qty: openTrade.qty,
                reason: `[REVERSAL CLOSE]: Executing AI Reversal to ${decision.signal}`
            };

            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(closePayload) });
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log(`[REVERSAL ENGINE] Step 2: Opening new ${decision.signal} position...`);
        }
        
        const tradePayload = {
            symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: decision.signal,
            order_type: decision.orderType || 'MARKET', price: decision.entryPrice, tp_price: decision.tpPrice || null,
            sl_price: decision.slPrice || null, execution_mode: config.execution_mode || 'PAPER', leverage: decision.leverage || 1,
            market_type: decision.marketType || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)),
            reason: decision.telemetry?.oracle_reasoning || decision.telemetry?.exit_reason || null 
        };
        
        await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tradePayload) });
    }

      } catch (assetErr) { 
          console.error(`[ASSET ERROR] ${asset}:`, assetErr.message); 
      } finally {
          // --- 🛡️ DEFENSE 1: MUTEX UNLOCK (Ensures the strategy is freed up even if an error occurs) ---
          await supabase.from('strategy_config').update({ is_processing: false }).eq('strategy', config.strategy);
      }
    }

    return res.status(200).json({ status: "Dynamic Scan Complete", results });
  } catch (err) { 
      return res.status(500).json({ error: err.message }); 
  }
}

// ... [fetchCoinbaseData and fetchMicrostructure helpers remain identical] ...
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
    let lookbackSeconds = safeGranularity === 'FIVE_MINUTE' ? 300 * 300 : 3600 * 300;
    const start = end - lookbackSeconds; 
    
    const privateKey = crypto.createPrivateKey({ key: secret, format: 'pem' });
    const token = jwt.sign({ iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `GET api.coinbase.com${path}` }, privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

    const resp = await fetch(`https://api.coinbase.com${path}?start=${start}&end=${end}&granularity=${safeGranularity}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) return null; const data = await resp.json();
    return data.candles?.map(c => ({ close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();
  } catch (err) { return null; }
}

async function fetchMicrostructure(asset, triggerCandles, apiKey, secret) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = [];
        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i]; const prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;
        return { indicators: { current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2) }, orderBook: { status: "REST Level 2 Restricted for CDE Futures. Using VWAP/ATR routing." }, derivativesData: { status: "Active" } };
    } catch (e) { return { indicators: {}, orderBook: {}, derivativesData: {} }; }
}