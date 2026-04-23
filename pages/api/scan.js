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

// --- 📱 DISCORD MESSENGER ---
async function sendDiscordAlert(title, description, color) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [{ title, description, color, timestamp: new Date().toISOString() }] })
        });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

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

      if (config.is_processing) {
          console.log(`[MUTEX LOCK] ${config.strategy} on ${asset} is currently processing a previous ping. Aborting to prevent double-fire.`);
          continue;
      }

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

        // 🧠 FETCH CURRENT OPEN TRADE
        const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', asset).eq('strategy_id', config.strategy).is('exit_price', null).order('id', { ascending: false }).limit(1);
        const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;
        
        // 🧠 FETCH SHORT-TERM MEMORY (ROLLING 24-HOUR PERFORMANCE)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: recentTrades } = await supabase.from('trade_logs')
            .select('*')
            .eq('symbol', asset)
            .eq('strategy_id', config.strategy)
            .not('exit_price', 'is', null)
            .gte('exit_time', twentyFourHoursAgo)
            .order('exit_time', { ascending: false })
            .limit(15);

        let forcedExit = null;
        let activePosition = null;
        let openOrders = [];
        let coinbaseProduct = asset.toUpperCase().trim();

        if (openTrade) {
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

                    // 🟢 THE FIX: SQUASHING GHOST PROFITS
                    // If we have no position, AND no entry order, we must verify IF it actually traded before logging PnL.
                    if (!activePosition && !entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 2) {
                            
                            // 1. Double check Historical Orders to see if the entry was canceled or filled
                            let wasCanceled = false;
                            try {
                                // Note: We only check the last hour of fills to save API limits, assuming fast scalps
                                const histPath = `/api/v3/brokerage/orders/historical/batch?order_status=CANCELLED&product_id=${coinbaseProduct}`;
                                const histResp = await fetch(`https://api.coinbase.com${histPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', histPath, apiKeyName, apiSecret)}` } });
                                if (histResp.ok) {
                                    const histData = await histResp.json();
                                    // If we find our exact limit price and side in the canceled bucket, it's a stale limit, NOT a trade.
                                    wasCanceled = histData.orders?.some(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));
                                }
                            } catch (e) { console.warn("Failed to check historical cancels:", e.message); }


                            if (wasCanceled || openTrade.order_type === 'LIMIT') {
                                // It was a limit order that never filled, or was manually canceled by the user on Coinbase.
                                const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                                await supabase.from('trade_logs').update({ exit_price: openTrade.entry_price, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                                
                                await sendDiscordAlert(`⏳ Limit Order Canceled: ${asset}`, `**Entry Price:** $${openTrade.entry_price}\n**Trigger:** Removed from Exchange`, 16776960);
                                continue; 

                            } else {
                                // If it wasn't canceled, it MUST have been a market order that hit its TP/SL natively.
                                if (openOrders.length > 0) {
                                    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                    await fetch(`https://api.coinbase.com${cancelPath}`, {
                                        method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) })
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
                                
                                await sendDiscordAlert(`🏁 Position Closed Natively: ${asset}`, `**Exit Price:** $${exactExitPrice}\n**Realized PnL:** $${rawPnl.toFixed(4)}\n**Trigger:** ${assumedReason}`, rawPnl >= 0 ? 5763719 : 15548997);
                                continue; 
                            }
                        }
                    }

                    // ... (The rest of your active position bracket logic remains exactly the same)
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

                        if (!hasTP && !hasSL && safeTpPrice && safeSlPrice) {
                            let priceCrossed = false;
                            if (openTrade.side === 'BUY' && (currentPrice >= parseFloat(safeTpPrice) || currentPrice <= parseFloat(safeSlPrice))) priceCrossed = true;
                            if (openTrade.side === 'SELL' && (currentPrice <= parseFloat(safeTpPrice) || currentPrice >= parseFloat(safeSlPrice))) priceCrossed = true;

                            if (priceCrossed) {
                                forcedExit = 'MISSED_BRACKET_MARKET_CLOSE';
                            } else {
                                try {
                                    const ocoPayload = {
                                        client_order_id: `nx_oco_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                        order_configuration: { trigger_bracket_gtc: { limit_price: safeTpPrice.toString(), stop_trigger_price: safeSlPrice.toString(), base_size: orderQty.toString() } }
                                    };
                                    await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                } catch (e) { 
                                    console.error(`[WATCHDOG FATAL] OCO:`, e.message); 
                                }
                            }
                        } 
                    }
                } catch (err) { 
                    console.error(`[WATCHDOG FAULT]`, err.message); 
                }
            }
        }

        if (openTrade && !forcedExit) {
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

            if (pnlPercent <= -0.08) { 
                const oracleVerdict = await evaluateTradeIdea({ mode: 'EMERGENCY', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, pnlPercent });
                if (oracleVerdict.action === 'MARKET_CLOSE') {
                    forcedExit = 'ORACLE_EMERGENCY_CLOSE';
                    await sendDiscordAlert("🚨 Emergency Override", `**Asset:** ${asset}\n**Action:** Forcing Market Close\n**Reason:** Down 8% - Structure Invalidated`, 15548997);
                }
            }
        }

        if (openTrade && !forcedExit && openTrade.tp_price && openTrade.entry_price && activePosition) {
            const isTripwireLocked = openTrade.reason && openTrade.reason.includes('[TRIPWIRE_CLEARED]');
            const totalDistance = Math.abs(openTrade.tp_price - openTrade.entry_price);
            const coveredDistance = Math.abs(currentPrice - openTrade.entry_price);
            const progress = coveredDistance / totalDistance;

            const isProfitable = (openTrade.side === 'BUY' && currentPrice > openTrade.entry_price) || 
                                 (openTrade.side === 'SELL' && currentPrice < openTrade.entry_price);

            const tripwireThreshold = parseFloat(config.parameters?.tripwire_percent) || 0.75;
            const displayPercent = Math.round(tripwireThreshold * 100);

            if (isProfitable && progress >= tripwireThreshold && !isTripwireLocked) {
                const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? (currentPrice - openTrade.entry_price) / openTrade.entry_price : (openTrade.entry_price - currentPrice) / openTrade.entry_price;

                const tripwireVerdict = await evaluateTradeIdea({
                    mode: 'MANUAL_REVIEW', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, pnlPercent, openTrade
                });

                const lockedReason = `${openTrade.reason || ''}\n\n[TRIPWIRE_CLEARED]: AI dynamically reviewed trade at ${displayPercent}% profit. Verdict: ${tripwireVerdict.action} - ${tripwireVerdict.reasoning}`;
                await supabase.from('trade_logs').update({ reason: lockedReason }).eq('id', openTrade.id);

                if (tripwireVerdict.action === 'MARKET_CLOSE') {
                     forcedExit = 'TRIPWIRE_SECURED_PROFIT';
                } 
                else if (tripwireVerdict.action === 'ADJUST_LIMITS') {
                     if (openOrders.length > 0) {
                         const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                         await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                     }
                     
                     let tickSize = (coinbaseProduct.includes('ETP') || coinbaseProduct.includes('ETH')) ? 0.50 : 0.01;
                     if (coinbaseProduct.includes('BIT') || coinbaseProduct.includes('BTC')) tickSize = 1.00;
                     
                     const finalTp = tripwireVerdict.tp_price || openTrade.tp_price;
                     const finalSl = tripwireVerdict.sl_price || openTrade.sl_price;

                     const safeTp = finalTp ? (Math.round(finalTp / tickSize) * tickSize).toFixed(2) : null;
                     const safeSl = finalSl ? (Math.round(finalSl / tickSize) * tickSize).toFixed(2) : null;

                     if (safeTp && safeSl) {
                         const executePath = '/api/v3/brokerage/orders';
                         const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                         const orderQty = activePosition.number_of_contracts;

                         const ocoPayload = {
                             client_order_id: `nx_tripwire_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                             order_configuration: { trigger_bracket_gtc: { limit_price: safeTp.toString(), stop_trigger_price: safeSl.toString(), base_size: orderQty.toString() } }
                         };
                         
                         try {
                             await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                             await supabase.from('trade_logs').update({ tp_price: safeTp, sl_price: safeSl }).eq('id', openTrade.id);
                             openTrade.tp_price = safeTp; openTrade.sl_price = safeSl;
                             
                             await sendDiscordAlert(`🛡️ Tripwire Activated: ${asset}`, `**Action:** Adjusted Limits (Break-Even/Trail)\n**New TP:** $${safeTp}\n**New SL:** $${safeSl}\n\n**🧠 Oracle Rationale:**\n_${tripwireVerdict.reasoning}_`, 16753920); 
                         } catch (e) { console.error(`[TRIPWIRE FAULT]`, e.message); }
                     }
                } 
            }
        }

        const marketData = { macro: macroCandles, trigger: triggerCandles };
        let decision = await evaluateStrategy(config.strategy, marketData, config.parameters);
        if (decision.error) continue;

        decision.telemetry = { 
            ...decision.telemetry, 
            cvd: microstructure.indicators.current_cvd,
            bids: microstructure.orderBook.bids_50_levels,
            asks: microstructure.orderBook.asks_50_levels,
            premium: microstructure.derivativesData.basis_premium_percent
        };

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

        const cooldownMinutes = config.parameters?.veto_cooldown_minutes || 15; 
        const lastVetoTime = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
        const isCooldownActive = (Date.now() - lastVetoTime) < (cooldownMinutes * 60000);

        if (isCooldownActive && !openTrade && !isReversal && !isDuplicate) {
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
                orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, marketType: config.parameters?.market_type || 'FUTURES', openTrade: currentTradeContext, recentHistory: recentTrades || [],
                dynamicSizing: config.parameters?.dynamic_sizing === true
            });

            decision.telemetry = { 
                ...decision.telemetry, 
                oracle_score: oracleVerdict.conviction_score, 
                oracle_reasoning: oracleVerdict.reasoning
            };

            if (oracleVerdict.action === 'VETO') {
                await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('strategy', config.strategy);
                decision.statusOverride = 'ORACLE VETO'; 
                
                const shadowTrade = {
                    symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', 
                    side: decision.signal, order_type: 'VETO', price: currentPrice, exit_price: currentPrice, 
                    exit_time: new Date().toISOString(), execution_mode: 'SHADOW', leverage: 1, 
                    market_type: config.parameters?.market_type || 'FUTURES', qty: 0, pnl: 0, 
                    reason: `[SHADOW VETO]: ${oracleVerdict.reasoning}`
                };
                await supabase.from('trade_logs').insert([shadowTrade]);
                decision.signal = null; 
                
                await sendDiscordAlert(`👻 Oracle Veto: ${asset}`, `**Signal:** ${normalizedSignal} (Rejected)\n\n**🧠 Oracle Rationale:**\n_${oracleVerdict.reasoning}_`, 10038562);

            } else {
                // 🟢 THE FIX: Pass the dynamic Order Type (LIMIT vs MARKET) from the Oracle to the Execution Engine
                decision.entryPrice = oracleVerdict.limit_price; 
                decision.orderType = oracleVerdict.order_type || 'LIMIT'; 

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
                
                if (oracleVerdict.size_multiplier && oracleVerdict.size_multiplier !== 1.0 && config.parameters?.target_usd) {
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
        const isExecutingReversal = openTrade && openTrade.side !== decision.signal;
        
        if (isExecutingReversal && config.execution_mode === 'LIVE' && openOrders.length > 0) {
            const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
            await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
          
        let finalQty = config.parameters?.qty || 10; 
        
        if (config.parameters?.target_usd && decision.entryPrice) {
            const isFutures = config.parameters?.market_type === 'FUTURES' || asset.includes('PERP') || asset.includes('CDE');
            
            if (isFutures) {
                let contractMultiplier = 1.0;
                if (asset.includes('ETP')) contractMultiplier = 0.1;
                if (asset.includes('BIT')) contractMultiplier = 0.01;
                
                const rawContracts = config.parameters.target_usd / (decision.entryPrice * contractMultiplier);
                finalQty = Math.round(rawContracts); 
                if (finalQty < 1) finalQty = 1; 
            } else {
                finalQty = config.parameters.target_usd / decision.entryPrice;
            }
        }
        
        const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
        const protocol = host.includes('localhost') ? 'http' : 'https';

        if (isExecutingReversal) {
            const closePayload = {
                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: decision.signal,
                order_type: 'MARKET', price: currentPrice, tp_price: null, sl_price: null,
                execution_mode: config.execution_mode || 'PAPER', leverage: decision.leverage || 1,
                market_type: decision.marketType || 'FUTURES', qty: openTrade.qty,
                reason: `[REVERSAL CLOSE]: Executing AI Reversal to ${decision.signal}\n\nOracle Reasoning: ${decision.telemetry?.oracle_reasoning || 'Standard Reversal'}`
            };

            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(closePayload) });
            await new Promise(resolve => setTimeout(resolve, 2000));
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
          await supabase.from('strategy_config').update({ is_processing: false }).eq('strategy', config.strategy);
      }
    }

    return res.status(200).json({ status: "Dynamic Scan Complete", results });
  } catch (err) { 
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
    
    let secondsPerCandle = 3600; 
    if (safeGranularity === 'ONE_MINUTE') secondsPerCandle = 60;
    else if (safeGranularity === 'FIVE_MINUTE') secondsPerCandle = 300;
    else if (safeGranularity === 'FIFTEEN_MINUTE') secondsPerCandle = 900;
    else if (safeGranularity === 'THIRTY_MINUTE') secondsPerCandle = 1800;
    else if (safeGranularity === 'ONE_HOUR') secondsPerCandle = 3600;
    else if (safeGranularity === 'TWO_HOUR') secondsPerCandle = 7200;
    else if (safeGranularity === 'SIX_HOUR') secondsPerCandle = 21600;
    else if (safeGranularity === 'ONE_DAY') secondsPerCandle = 86400;

    let lookbackSeconds = secondsPerCandle * 300; 
    const start = end - lookbackSeconds; 
    
    const privateKey = crypto.createPrivateKey({ key: secret, format: 'pem' });
    const token = jwt.sign({ iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `GET api.coinbase.com${path}` }, privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } });

    const resp = await fetch(`https://api.coinbase.com${path}?start=${start}&end=${end}&granularity=${safeGranularity}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Coinbase HTTP ${resp.status}`); 
    const data = await resp.json();
    
    return data.candles?.map(c => ({ 
        open: c.open ? parseFloat(c.open) : parseFloat(c.close),
        close: parseFloat(c.close), 
        high: parseFloat(c.high), 
        low: parseFloat(c.low), 
        volume: parseFloat(c.volume) 
    })).reverse();
  } catch (err) { throw err; } 
}

async function fetchMicrostructure(asset, triggerCandles, apiKey, secret) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = [];
        let cvd = 0; 
        
        const cvdCandles = triggerCandles.slice(-50);
        for (let i = 0; i < cvdCandles.length; i++) {
            const c = cvdCandles[i];
            const range = c.high - c.low;
            
            let openPrice = c.open;
            if (isNaN(openPrice) || openPrice === undefined) {
                openPrice = i > 0 ? cvdCandles[i-1].close : c.close;
            }

            if (range > 0) {
                cvd += c.volume * ((c.close - openPrice) / range);
            }
        }

        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i]; const prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        let coinbaseProduct = asset.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) {
            if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
            else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
            else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
        }
        
        let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
        if (baseAsset === 'ETP') baseAsset = 'ETH';
        if (baseAsset === 'AVP') baseAsset = 'AVAX'; 
        const spotProduct = `${baseAsset}-USD`;

        let orderBookData = { status: "Unavailable" };
        let basisPremium = 0;
        let spotPrice = currentPrice;

        if (apiKey && secret) {
            try {
                const bookPath = `/api/v3/brokerage/product_book?product_id=${coinbaseProduct}&limit=50`;
                const bookResp = await fetch(`https://api.coinbase.com${bookPath}`, { 
                    headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', bookPath, apiKey, secret)}` } 
                });

                if (bookResp.ok) {
                    const bookJson = await bookResp.json();
                    const bids = bookJson.pricebook?.bids || [];
                    const asks = bookJson.pricebook?.asks || [];
                    
                    let totalBidSize = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    let totalAskSize = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
                    
                    orderBookData = {
                        bids_50_levels: (totalBidSize || 0).toFixed(2),
                        asks_50_levels: (totalAskSize || 0).toFixed(2),
                        imbalance: totalBidSize > totalAskSize ? "BULLISH (Bids > Asks)" : "BEARISH (Asks > Bids)"
                    };
                }
            } catch (err) {
                console.error("[OrderBook Fetch Error]", err.message);
            }

            try {
                const productPath = `/api/v3/brokerage/products/${spotProduct}`;
                const productResp = await fetch(`https://api.coinbase.com${productPath}`, { 
                    headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', productPath, apiKey, secret)}` } 
                });

                if (productResp.ok) {
                    const productJson = await productResp.json();
                    spotPrice = parseFloat(productJson.price || currentPrice);
                    basisPremium = ((currentPrice - spotPrice) / spotPrice) * 100;
                }
            } catch (err) {
                console.error("[SpotPrice Fetch Error]", err.message);
            }
        }

        return { 
            indicators: { current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2), current_cvd: cvd.toFixed(2) }, 
            orderBook: orderBookData, 
            derivativesData: { 
                spot_price: spotPrice.toFixed(2),
                futures_price: currentPrice.toFixed(2),
                basis_premium_percent: basisPremium.toFixed(4),
                sentiment: basisPremium > 0.1 ? "OVERHEATED LONGS (Premium)" : (basisPremium < -0.1 ? "OVERHEATED SHORTS (Discount)" : "NEUTRAL")
            } 
        };
    } catch (e) { return { indicators: {}, orderBook: {}, derivativesData: {} }; }
}