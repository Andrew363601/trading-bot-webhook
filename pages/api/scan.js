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

const getAssetMetrics = (symbol) => {
    let multiplier = 1.0;
    let tickSize = 0.01;
    
    if (symbol.includes('ETP') || symbol.includes('ETH')) { multiplier = 0.1; tickSize = 0.50; }
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 1.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    
    return { multiplier, tickSize };
};

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

      if (config.is_processing) continue;
      await supabase.from('strategy_config').update({ is_processing: true }).eq('strategy', config.strategy);

      let trapSprung = false;
      let trapExpired = false;

      try {
        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        const [macroCandles, triggerCandles] = await Promise.all([
          fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
          fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
        ]);

        if (!macroCandles || !triggerCandles || macroCandles.length < 21 || triggerCandles.length < 21) continue;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        // 🟢 THE FIX: Passing macroCandles into the microstructure engine
        const microstructure = await fetchMicrostructure(asset, triggerCandles, macroCandles, apiKeyName, apiSecret);

        const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', asset).eq('strategy_id', config.strategy).is('exit_price', null).order('id', { ascending: false }).limit(1);
        const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;
        
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
                        activePosition = posData.positions?.find(p => p.product_id === coinbaseProduct && Math.abs(parseFloat(p.number_of_contracts)) > 0);
                    }
                    if (orderResp.ok) {
                        const orderData = await orderResp.json();
                        openOrders = orderData.orders || [];
                    }

                    const { multiplier, tickSize } = getAssetMetrics(coinbaseProduct);
                    let entryOrderExists = openOrders.some(o => 
                        o.side.toUpperCase() === openTrade.side.toUpperCase() && 
                        Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2)
                    );

                    if (activePosition && entryOrderExists) {
                        const activeQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                        const expectedQty = Math.abs(parseFloat(openTrade.qty));
                        
                        if (activeQty < expectedQty) {
                            const targetOrder = openOrders.find(o => o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2));
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] }) });
                            }
                            
                            const updatedReason = `${openTrade.reason || ''}\n\n[PARTIAL FILL]: Market moved. Remaining ${expectedQty - activeQty} contracts canceled.`;
                            await supabase.from('trade_logs').update({ qty: activeQty, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.qty = activeQty;
                            openTrade.reason = updatedReason;
                            
                            await sendDiscordAlert(`⚠️ Partial Fill Detected: ${asset}`, `**Filled:** ${activeQty} / ${expectedQty}\n**Action:** Unfilled limit order canceled. Proceeding to bracket active contracts.`, 16753920);
                            
                            openOrders = openOrders.filter(o => o.order_id !== targetOrder?.order_id);
                            entryOrderExists = false;
                        }
                    }

                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        
                        let totalAllowedMinutes = 15; 
                        const initialMatch = openTrade.reason?.match(/Fill:\s*(\d+)m/i);
                        if (initialMatch) totalAllowedMinutes = parseInt(initialMatch[1]);

                        const extensionMatches = [...(openTrade.reason?.matchAll(/extended wait by\s*(\d+)m/gi) || [])];
                        extensionMatches.forEach(match => {
                            totalAllowedMinutes += parseInt(match[1]);
                        });

                        if (minutesOpen > totalAllowedMinutes) {
                            const oracleVerdict = await evaluateTradeIdea({ mode: 'PENDING_REVIEW', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, openTrade });
                            
                            if (oracleVerdict.action === 'CANCEL' || minutesOpen > 60) {
                                const targetOrder = openOrders.find(o => o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2));
                                if (targetOrder) {
                                    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                    await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] }) });
                                }
                                
                                const finalReason = minutesOpen > 60 ? 'Hard 60m TTL Expired' : oracleVerdict.reasoning;
                                const updatedReason = `${openTrade.reason || ''}\n\n[EXIT TRIGGER]: ORACLE_CANCELED - ${finalReason}`;
                                await supabase.from('trade_logs').update({ exit_price: openTrade.entry_price, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                                
                                await sendDiscordAlert(`⏳ Pending Limit Canceled: ${asset}`, `**Action:** Oracle aborted setup.\n**Reason:** ${finalReason}`, 15548997);
                                continue;
                                
                            } else if (oracleVerdict.action === 'HOLD') {
                                const newMins = oracleVerdict.new_expectancy || 15;
                                const updatedReason = `${openTrade.reason || ''}\n\n[PENDING_REVIEW]: Oracle extended wait by ${newMins}m. Reason: ${oracleVerdict.reasoning}`;
                                
                                await supabase.from('trade_logs').update({ reason: updatedReason }).eq('id', openTrade.id);
                                openTrade.reason = updatedReason;
                                continue;
                            }
                        }
                        continue; 
                    }

                    if (!activePosition && !entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 2) {
                            let wasCanceled = false;
                            try {
                                const histPath = `/api/v3/brokerage/orders/historical/batch?order_status=CANCELLED&product_id=${coinbaseProduct}`;
                                const histResp = await fetch(`https://api.coinbase.com${histPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', histPath, apiKeyName, apiSecret)}` } });
                                if (histResp.ok) {
                                    const histData = await histResp.json();
                                    wasCanceled = histData.orders?.some(o => 
                                        o.side.toUpperCase() === openTrade.side.toUpperCase() && 
                                        Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2)
                                    );
                                }
                            } catch (e) { console.warn("Failed to check historical cancels:", e.message); }

                            if (wasCanceled || openTrade.order_type === 'LIMIT') {
                                const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                                await supabase.from('trade_logs').update({ exit_price: openTrade.entry_price, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                                await sendDiscordAlert(`⏳ Limit Order Canceled: ${asset}`, `**Entry Price:** $${openTrade.entry_price}\n**Trigger:** Removed from Exchange manually.`, 16776960);
                                continue; 
                            } else {
                                if (openOrders.length > 0) {
                                    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                    await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                                }

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
                        const orderQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                        const executePath = '/api/v3/brokerage/orders';

                        const safeSlPrice = openTrade.sl_price ? (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(4) : null;
                        const safeTpPrice = openTrade.tp_price ? (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(4) : null;

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
                                    const ocoResp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                    const ocoResult = await ocoResp.json();
                                    
                                    if (ocoResp.ok && ocoResult.success !== false) {
                                        await sendDiscordAlert(`🎯 Brackets Deployed (Watchdog): ${asset}`, `**Take Profit:** $${safeTpPrice}\n**Stop Loss:** $${safeSlPrice}\n**Status:** Limit Fill Detected, Brackets Active on Exchange`, 10181046);
                                    } else {
                                        console.error(`[WATCHDOG REJECT] OCO Failed:`, JSON.stringify(ocoResult));
                                        await sendDiscordAlert(`⚠️ Bracket Failed: ${asset}`, `**Action:** Missing TP/SL protection!\n**Details:** Exchange rejected the Watchdog OCO order.`, 15548997);
                                    }
                                } catch (e) { console.error(`[WATCHDOG FATAL] OCO:`, e.message); }
                            }
                        } 
                    }
                } catch (err) { console.error(`[WATCHDOG FAULT]`, err.message); }
            }
        }

        if (openTrade && !forcedExit && openTrade.tp_price && openTrade.sl_price && openTrade.entry_price && activePosition) {
            const isTpTripwireLocked = openTrade.reason && openTrade.reason.includes('[TP_TRIPWIRE_CLEARED]');
            const isSlTripwireLocked = openTrade.reason && openTrade.reason.includes('[SL_TRIPWIRE_CLEARED]');
            
            const entryPrice = parseFloat(openTrade.entry_price);
            const pnlPercent = (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

            const tpTripwireThreshold = parseFloat(config.parameters?.tp_tripwire_percent) || 0.75;
            const slTripwireThreshold = parseFloat(config.parameters?.sl_tripwire_percent) || 0.85;

            const isProfitable = pnlPercent > 0;
            const isNegative = pnlPercent < 0;

            const distToTp = Math.abs(openTrade.tp_price - entryPrice);
            const distToSl = Math.abs(openTrade.sl_price - entryPrice);
            const coveredDistance = Math.abs(currentPrice - entryPrice);

            const progressToTp = isProfitable && distToTp > 0 ? (coveredDistance / distToTp) : 0;
            const progressToSl = isNegative && distToSl > 0 ? (coveredDistance / distToSl) : 0;

            if (isProfitable && progressToTp >= tpTripwireThreshold && !isTpTripwireLocked) {
                const tripwireVerdict = await evaluateTradeIdea({
                    mode: 'MANUAL_REVIEW', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, pnlPercent, openTrade
                });

                const lockedReason = `${openTrade.reason || ''}\n\n[TP_TRIPWIRE_CLEARED]: AI reviewed trade at +${Math.round(tpTripwireThreshold * 100)}% to TP. Verdict: ${tripwireVerdict.action} - ${tripwireVerdict.reasoning}`;
                await supabase.from('trade_logs').update({ reason: lockedReason }).eq('id', openTrade.id);
                openTrade.reason = lockedReason;

                if (tripwireVerdict.action === 'MARKET_CLOSE') {
                     forcedExit = 'TRIPWIRE_SECURED_PROFIT';
                } else if (tripwireVerdict.action === 'ADJUST_LIMITS') {
                     if (openOrders.length > 0) {
                         const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                         await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                     }
                     
                     const { tickSize } = getAssetMetrics(coinbaseProduct);
                     const finalTp = tripwireVerdict.tp_price || openTrade.tp_price;
                     const finalSl = tripwireVerdict.sl_price || openTrade.sl_price;

                     const safeTp = finalTp ? (Math.round(finalTp / tickSize) * tickSize).toFixed(4) : null;
                     const safeSl = finalSl ? (Math.round(finalSl / tickSize) * tickSize).toFixed(4) : null;

                     if (safeTp && safeSl) {
                         const executePath = '/api/v3/brokerage/orders';
                         const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                         const orderQty = Math.abs(parseFloat(activePosition.number_of_contracts));

                         const ocoPayload = {
                             client_order_id: `nx_tripwire_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                             order_configuration: { trigger_bracket_gtc: { limit_price: safeTp.toString(), stop_trigger_price: safeSl.toString(), base_size: orderQty.toString() } }
                         };
                         
                         try {
                             await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                             await supabase.from('trade_logs').update({ tp_price: safeTp, sl_price: safeSl }).eq('id', openTrade.id);
                             openTrade.tp_price = safeTp; openTrade.sl_price = safeSl;
                             
                             await sendDiscordAlert(`🛡️ Offensive Tripwire: ${asset}`, `**Action:** Adjusted Limits (Trail)\n**New TP:** $${safeTp}\n**New SL:** $${safeSl}\n**Reason:** ${tripwireVerdict.reasoning}`, 16753920); 
                         } catch (e) { console.error(`[TRIPWIRE FAULT]`, e.message); }
                     }
                } 
            }
            else if (isNegative && progressToSl >= slTripwireThreshold && !isSlTripwireLocked) {
                 const tripwireVerdict = await evaluateTradeIdea({
                    mode: 'DEFENSIVE_REVIEW', asset, strategy: config.strategy, currentPrice, candles: triggerCandles, macroCandles: macroCandles, indicators: microstructure.indicators, orderBook: microstructure.orderBook, derivativesData: microstructure.derivativesData, pnlPercent, openTrade
                 });

                 const lockedReason = `${openTrade.reason || ''}\n\n[SL_TRIPWIRE_CLEARED]: AI reviewed trade at -${Math.round(slTripwireThreshold * 100)}% to SL. Verdict: ${tripwireVerdict.action} - ${tripwireVerdict.reasoning}`;
                 await supabase.from('trade_logs').update({ reason: lockedReason }).eq('id', openTrade.id);
                 openTrade.reason = lockedReason;

                 if (tripwireVerdict.action === 'MARKET_CLOSE') {
                     forcedExit = 'DEFENSIVE_MARKET_CLOSE';
                     await sendDiscordAlert(`🛡️ Defensive Tripwire: ${asset}`, `**Action:** Oracle forced MARKET_CLOSE to prevent full stop-out.\n**Reason:** ${tripwireVerdict.reasoning}`, 15548997);
                 } else {
                     await sendDiscordAlert(`🛡️ Defensive Tripwire: ${asset}`, `**Action:** HOLD.\n**Reason:** Oracle identified wick/liquidity sweep. Holding structure.`, 3447003);
                 }
            }
        }

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
            const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
            const protocol = host.includes('localhost') ? 'http' : 'https';
            
            const exitPayload = {
                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', 
                side: (openTrade.side === 'BUY' || openTrade.side === 'LONG') ? 'SELL' : 'BUY',
                order_type: 'MARKET', price: currentPrice, tp_price: null, sl_price: null,
                execution_mode: config.execution_mode || 'PAPER', leverage: openTrade.leverage || 1,
                market_type: config.parameters?.market_type || 'FUTURES', qty: openTrade.qty,
                reason: forcedExit
            };
            
            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exitPayload) });
            
            const scanEntry = { strategy: config.strategy, asset, telemetry: microstructure.indicators || {}, status: `HIT_${forcedExit}` };
            results.push(scanEntry);
            await supabase.from('scan_results').insert([scanEntry]);
            
            continue; 
        } 

        if (config.trap_side && config.trap_price && config.trap_expires_at) {
            const expiresAt = new Date(config.trap_expires_at).getTime();
            if (Date.now() > expiresAt) {
                trapExpired = true;
            } else {
                if (config.trap_side === 'BUY' && currentPrice <= config.trap_price) trapSprung = true;
                if (config.trap_side === 'SELL' && currentPrice >= config.trap_price) trapSprung = true;
            }
        }

        if (trapSprung) {
            const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
            const protocol = host.includes('localhost') ? 'http' : 'https';
            
            if (config.execution_mode === 'LIVE' && openOrders.length > 0) {
                 const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                 await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                 await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const isExecutingReversal = openTrade && openTrade.side !== config.trap_side;
            if (isExecutingReversal) {
                const closePayload = {
                    symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: config.trap_side,
                    order_type: 'MARKET', price: currentPrice, tp_price: null, sl_price: null,
                    execution_mode: config.execution_mode || 'PAPER', leverage: openTrade.leverage || 1,
                    market_type: config.parameters?.market_type || 'FUTURES', qty: openTrade.qty,
                    reason: `[REVERSAL CLOSE]: Virtual Trap Sprung at $${config.trap_price}. Reversing to ${config.trap_side}`
                };
                
                const closeResp = await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(closePayload) });
                if (!closeResp.ok) {
                    console.error(`[RACE CONDITION] Trap reversal failed to close existing trade for ${asset}`);
                    await sendDiscordAlert(`⚠️ Trap Aborted: ${asset}`, `**Issue:** Failed to close existing position. Aborting new trap entry to prevent double exposure.`, 15548997);
                    continue; 
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            let finalQty = config.parameters?.qty || 10; 
            if (config.parameters?.target_usd) {
                const isFutures = config.parameters?.market_type === 'FUTURES' || asset.includes('PERP') || asset.includes('CDE');
                if (isFutures) {
                    const { multiplier } = getAssetMetrics(asset);
                    finalQty = Math.max(1, Math.round(config.parameters.target_usd / (currentPrice * multiplier))); 
                } else {
                    finalQty = config.parameters.target_usd / currentPrice;
                }
            }

            const slP = config.parameters?.sl_percent || 0.01; 
            const tpP = config.parameters?.tp_percent || 0.02;
            const trapTpPrice = config.trap_side === 'BUY' ? currentPrice * (1 + tpP) : currentPrice * (1 - tpP);
            const trapSlPrice = config.trap_side === 'BUY' ? currentPrice * (1 - slP) : currentPrice * (1 + slP);
            const { tickSize } = getAssetMetrics(asset);

            const trapPayload = {
                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: config.trap_side,
                order_type: 'MARKET', price: currentPrice, 
                tp_price: parseFloat((Math.round(trapTpPrice / tickSize) * tickSize).toFixed(4)), 
                sl_price: parseFloat((Math.round(trapSlPrice / tickSize) * tickSize).toFixed(4)),
                execution_mode: config.execution_mode || 'PAPER', leverage: config.parameters?.leverage || 1,
                market_type: config.parameters?.market_type || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)),
                reason: `[VIRTUAL TRAP SPRUNG]: Oracle Thesis Executed at $${config.trap_price}`
            };
            
            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trapPayload) });
            
            const scanEntry = { strategy: config.strategy, asset, telemetry: microstructure.indicators || {}, status: `HIT_TRAP_${config.trap_side}` };
            results.push(scanEntry);
            await supabase.from('scan_results').insert([scanEntry]);
            
            config.clear_trap = true;
            continue; 
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

        if (decision.signal) {
            const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
            decision.signal = normalizedSignal; 
            
            const isReversal = openTrade && openTrade.side !== normalizedSignal;
            const isDuplicate = openTrade && !isReversal;

            const cooldownMinutes = config.parameters?.veto_cooldown_minutes || 15; 
            const lastVetoTime = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
            const isCooldownActive = (Date.now() - lastVetoTime) < (cooldownMinutes * 60000);

            if (isDuplicate) {
                decision.signal = null; 
            } else if (isCooldownActive) {
                decision.signal = null;
                decision.statusOverride = `COOLDOWN (${cooldownMinutes}M)`; 
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
                    dynamicSizing: config.parameters?.dynamic_sizing === true,
                    activeThesis: config.active_thesis 
                });

                config.new_thesis = oracleVerdict.working_thesis;

                if (oracleVerdict.trap_side && oracleVerdict.trap_price && oracleVerdict.trap_expires_in_minutes) {
                    config.new_trap_side = oracleVerdict.trap_side;
                    config.new_trap_price = oracleVerdict.trap_price;
                    config.new_trap_expires_at = new Date(Date.now() + (oracleVerdict.trap_expires_in_minutes * 60000)).toISOString();
                } else if (oracleVerdict.action === 'MARKET_CLOSE' || oracleVerdict.action === 'APPROVE') {
                    config.clear_trap = true;
                }

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
                        reason: `[SHADOW VETO]: ${oracleVerdict.reasoning}\n\n[WORKING THESIS]: ${oracleVerdict.working_thesis || 'None'}`
                    };
                    await supabase.from('trade_logs').insert([shadowTrade]);
                    decision.signal = null; 
                    
                    await sendDiscordAlert(`👻 Oracle Veto: ${asset}`, `**Signal:** ${normalizedSignal} (Rejected)\n\n**🧠 Oracle Rationale:**\n_${oracleVerdict.reasoning}_`, 10038562);

                } else {
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
                 
                    const { tickSize } = getAssetMetrics(asset);
                    decision.tpPrice = Math.round(decision.tpPrice / tickSize) * tickSize;
                    decision.slPrice = Math.round(decision.slPrice / tickSize) * tickSize;
                    
                    if (oracleVerdict.size_multiplier && oracleVerdict.size_multiplier !== 1.0 && config.parameters?.target_usd) {
                        config.parameters.target_usd = config.parameters.target_usd * oracleVerdict.size_multiplier;
                    }

                    const finalFormattedReason = `[EXPECTANCIES] Fill: ${oracleVerdict.fill_expectancy || 0}m | TP: ${oracleVerdict.tp_expectancy || 0}m | R:R: ${oracleVerdict.risk_reward || 0}\n\n${oracleVerdict.reasoning || ''}\n\n[WORKING THESIS]: ${oracleVerdict.working_thesis || 'None'}`;
                    decision.telemetry.oracle_reasoning = finalFormattedReason;
                }
            }
        }

        const finalStatus = decision.statusOverride ? decision.statusOverride : (decision.signal ? "RESONANT" : "STABLE");
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
                    const { multiplier } = getAssetMetrics(asset);
                    const rawContracts = config.parameters.target_usd / (decision.entryPrice * multiplier);
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

                const closeResp = await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(closePayload) });
                if (!closeResp.ok) {
                    console.error(`[RACE CONDITION] Standard reversal failed to close existing trade for ${asset}`);
                    await sendDiscordAlert(`⚠️ Reversal Aborted: ${asset}`, `**Issue:** Failed to close existing position. Aborting new entry to prevent double exposure.`, 15548997);
                    continue; 
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const tradePayload = {
                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: decision.signal,
                order_type: decision.orderType || 'MARKET', price: decision.entryPrice, tp_price: decision.tpPrice || null,
                sl_price: decision.slPrice || null, execution_mode: config.execution_mode || 'PAPER', leverage: decision.leverage || 1,
                market_type: decision.marketType || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)),
                reason: decision.telemetry?.oracle_reasoning || null 
            };
            
            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tradePayload) });
        }

      } catch (assetErr) { 
          console.error(`[ASSET ERROR] ${asset}:`, assetErr.message); 
      } finally {
          const finalUpdates = { is_processing: false };
          if (config.new_thesis) finalUpdates.active_thesis = config.new_thesis;
          
          if (config.new_trap_side) {
              finalUpdates.trap_side = config.new_trap_side;
              finalUpdates.trap_price = config.new_trap_price;
              finalUpdates.trap_expires_at = config.new_trap_expires_at;
          } else if (config.clear_trap || trapExpired) {
              finalUpdates.trap_side = null;
              finalUpdates.trap_price = null;
              finalUpdates.trap_expires_at = null;
          }

          await supabase.from('strategy_config').update(finalUpdates).eq('strategy', config.strategy);
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

// 🟢 THE FIX: Upgraded to calculate Macro CVD and Point of Control (POC)
async function fetchMicrostructure(asset, triggerCandles, macroCandles, apiKey, secret) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = [];
        let cvd = 0; 
        
        // --- MICRO CVD CALCULATION ---
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

        // --- MICRO VWAP & ATR ---
        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i]; const prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        // 🟢 THE FIX: MACRO CVD CALCULATION (Last 50 Macro Candles)
        let macro_cvd = 0;
        const macroCvdCandles = macroCandles.slice(-50);
        for (let i = 0; i < macroCvdCandles.length; i++) {
            const c = macroCvdCandles[i];
            const range = c.high - c.low;
            let openPrice = c.open;
            if (isNaN(openPrice) || openPrice === undefined) {
                openPrice = i > 0 ? macroCvdCandles[i-1].close : c.close;
            }
            if (range > 0) {
                macro_cvd += c.volume * ((c.close - openPrice) / range);
            }
        }

        // 🟢 THE FIX: POINT OF CONTROL (POC) ENGINE (Last 150 Macro Candles)
        let minPrice = Infinity;
        let maxPrice = -Infinity;
        const pocCandles = macroCandles.slice(-150);
        
        pocCandles.forEach(c => {
            if (c.low < minPrice) minPrice = c.low;
            if (c.high > maxPrice) maxPrice = c.high;
        });

        const numBuckets = 50;
        const bucketSize = (maxPrice - minPrice) / numBuckets;
        const volumeProfile = new Array(numBuckets).fill(0);

        pocCandles.forEach(c => {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            let bucketIndex = Math.floor((typicalPrice - minPrice) / bucketSize);
            if (bucketIndex >= numBuckets) bucketIndex = numBuckets - 1; 
            if (bucketIndex < 0) bucketIndex = 0;
            volumeProfile[bucketIndex] += c.volume;
        });

        let maxVol = -1;
        let pocIndex = 0;
        for(let i=0; i<numBuckets; i++) {
            if (volumeProfile[i] > maxVol) {
                maxVol = volumeProfile[i];
                pocIndex = i;
            }
        }
        const macro_poc = minPrice + (pocIndex * bucketSize) + (bucketSize / 2);


        const assetMap = {
            'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 
            'AVP': 'AVAX', 'LCP': 'LTC', 'LNP': 'LINK', 'DOP': 'DOGE', 'BHP': 'BCH'
        };

        let coinbaseProduct = asset.toUpperCase().trim();
        let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
        baseAsset = assetMap[baseAsset] || baseAsset;
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
            indicators: { 
                current_vwap: vwap.toFixed(2), 
                current_atr: atr.toFixed(2), 
                current_cvd: cvd.toFixed(2),
                macro_cvd: macro_cvd.toFixed(2), // 🟢 Injected into telemetry
                macro_poc: macro_poc.toFixed(2)  // 🟢 Injected into telemetry
            }, 
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