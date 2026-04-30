// workers/watchdog.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { buildRadarChartUrl } from '../lib/discord-chart.js'; 

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function sendDiscordAlert({ title, description, color, fields = [], imageUrl = null }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        const embed = { title, description, color, timestamp: new Date().toISOString() };
        if (fields.length > 0) embed.fields = fields;
        if (imageUrl) embed.image = { url: imageUrl };
        await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

function generateCoinbaseToken(method, path, apiKey, apiSecret) {
    const privateKey = crypto.createPrivateKey({ key: apiSecret.replace(/\\n/g, '\n'), format: 'pem' });
    const uriPath = path.split('?')[0];
    return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
    );
}

const getAssetMetrics = (symbol) => {
    let multiplier = 1.0; let tickSize = 0.01;
    if (symbol.includes('ETP') || symbol.includes('ETH')) { multiplier = 0.1; tickSize = 0.50; }
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 5.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    return { multiplier, tickSize };
};

async function buildWatchdogChart(symbol, currentPrice, apiKeyName, apiSecret, openTrade = null) {
    try {
        let telemetry = {};
        const { data: scanData } = await supabase.from('scan_results').select('telemetry').eq('asset', symbol).order('created_at', { ascending: false }).limit(1);
        if (scanData && scanData.length > 0) telemetry = scanData[0].telemetry || {};

        const end = Math.floor(Date.now() / 1000);
        const start = end - (300 * 50); 
        let coinbaseProduct = symbol.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
        const candlePath = `/api/v3/brokerage/products/${coinbaseProduct}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE`;
        const token = generateCoinbaseToken('GET', candlePath, apiKeyName, apiSecret);
        
        const candleResp = await fetch(`https://api.coinbase.com${candlePath}`, { headers: { 'Authorization': `Bearer ${token}` } });
        let recentCandles = [];
        if (candleResp.ok) {
            const cData = await candleResp.json();
            recentCandles = cData.candles?.map(c => ({ open: parseFloat(c.open || c.close), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) })).reverse() || [];
        }
        
        return await buildRadarChartUrl({
            asset: symbol, candles: recentCandles, currentPrice: currentPrice,
            poc: telemetry.macro_poc, upperNode: telemetry.upper_macro_node, lowerNode: telemetry.lower_macro_node,
            openTrade: openTrade
        });
    } catch(e) { console.error("[WATCHDOG CHART FAILED]", e.message); return null; }
}

async function pingHermes(payload) {
    const hermesEndpoint = process.env.HERMES_WEBHOOK_URL || 'http://localhost:8000/api/wake';
    try {
        await fetch(hermesEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error(`[HERMES PING FAILED] Is the Docker container running?`);
    }
}

export async function startWatchdog() {
    console.log(`[WATCHDOG] Physical Exchange Janitor online. Sweeping orders...`);
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    setInterval(async () => {
        try {
            const { data: openTrades } = await supabase.from('trade_logs').select('*').is('exit_price', null);
            if (!openTrades || openTrades.length === 0) return;

            for (const openTrade of openTrades) {
                const asset = openTrade.symbol;
                let coinbaseProduct = asset.toUpperCase().trim();
                if (!coinbaseProduct.includes('-')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP'); 

                const tickerPath = `/api/v3/brokerage/products/${coinbaseProduct}/ticker`;
                const tickerResp = await fetch(`https://api.coinbase.com${tickerPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', tickerPath, apiKeyName, apiSecret)}` } });
                
                let tickerData;
                try {
                    tickerData = await tickerResp.json();
                } catch (jsonErr) {
                    console.error(`[WATCHDOG API FAULT] Coinbase returned non-JSON data for ${asset}. Skipping tick...`);
                    continue; 
                }
                
                const currentPrice = parseFloat(tickerData.trades?.[0]?.price || tickerData.best_bid || tickerData.best_ask);
                
                if (!currentPrice || isNaN(currentPrice)) {
                    console.log(`[WATCHDOG WAIT] Ticker failed to fetch valid price for ${asset}.`);
                    continue;
                }

                if (!openTrade.entry_price || openTrade.entry_price === 0) {
                     console.log(`[WATCHDOG] Missing entry price detected for trade ${openTrade.id}. Attempting to self-heal...`);
                     const fillPath = `/api/v3/brokerage/orders/historical/batch?order_status=FILLED&product_id=${coinbaseProduct}`;
                     try {
                         const fillResp = await fetch(`https://api.coinbase.com${fillPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', fillPath, apiKeyName, apiSecret)}` } });
                         if (fillResp.ok) {
                             const fillData = await fillResp.json();
                             const entryOrder = fillData.orders?.find(o => o.client_order_id === `nx_entry_${openTrade.id}`);
                             if (entryOrder && entryOrder.average_filled_price) {
                                 const trueEntryPrice = parseFloat(entryOrder.average_filled_price);
                                 await supabase.from('trade_logs').update({ entry_price: trueEntryPrice }).eq('id', openTrade.id);
                                 openTrade.entry_price = trueEntryPrice;
                                 console.log(`[WATCHDOG] Successfully healed entry price for trade ${openTrade.id} to $${trueEntryPrice}`);
                             }
                         }
                     } catch(e) { console.error("[WATCHDOG SELF-HEAL FAULT]", e.message); }
                     
                     if (!openTrade.entry_price || openTrade.entry_price === 0) {
                         openTrade.entry_price = currentPrice;
                         await supabase.from('trade_logs').update({ entry_price: currentPrice }).eq('id', openTrade.id);
                     }
                }

                let activePosition = null;
                let openOrders = [];
                
                if (openTrade.execution_mode === 'LIVE') {
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
                    
                    let entryClientId = `nx_entry_${openTrade.id}`;
                    let ocoClientId = `nx_oco_${openTrade.id}`;

                    let entryOrderExists = openOrders.some(o => 
                        o.client_order_id === entryClientId || 
                        ((o.side || '').toUpperCase() === (openTrade.side || '').toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2))
                    );

                    if (activePosition && entryOrderExists) {
                        const activeQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                        const expectedQty = Math.abs(parseFloat(openTrade.qty));
                        
                        if (activeQty < expectedQty) {
                            const targetOrder = openOrders.find(o => (o.side || '').toUpperCase() === (openTrade.side || '').toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2));
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] }) });
                            }
                            const updatedReason = `${openTrade.reason || ''}\n\n[PARTIAL FILL]: Market moved. Remaining ${expectedQty - activeQty} contracts canceled.`;
                            await supabase.from('trade_logs').update({ qty: activeQty, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.qty = activeQty;
                            entryOrderExists = false;
                        }
                    }

                    if (activePosition && openTrade.entry_price) {
                        const { data: configData, error: configErr } = await supabase
                            .from('strategy_config')
                            .select('*')
                            .eq('id', openTrade.strategy_id)
                            .single();
                            
                        if (configErr) console.error(`[WATCHDOG CONFIG FETCH] ERROR:`, configErr.message);

                        const params = configData?.parameters || {};
                        
                        const pnlPercent = (openTrade.side || '').toUpperCase() === 'BUY' 
                            ? (currentPrice - openTrade.entry_price) / openTrade.entry_price 
                            : (openTrade.entry_price - currentPrice) / openTrade.entry_price;
                            
                        const rawTripwire = params.tripwire_percent || params.tp_tripwire_percent || 0;
                        const tripwire = parseFloat(rawTripwire) / 100;
                        const trailStep = parseFloat(params.trail_step_percent || 0) / 100;
                        const trailActivation = parseFloat(params.trail_activation_percent || rawTripwire || 0) / 100;

                        if (!openTrade.reason?.includes('[TRIPWIRE_ACTIVATED]') && tripwire > 0) {
                            console.log(`[HARVEST DIAGNOSTICS] ${asset} | Live PnL: ${(pnlPercent * 100).toFixed(2)}% | Tripwire Target: ${(tripwire * 100).toFixed(2)}% | Trail Step: ${(trailStep * 100).toFixed(2)}%`);
                        }

                        if (tripwire > 0 && pnlPercent >= tripwire && !openTrade.reason?.includes('[TRIPWIRE_ACTIVATED]')) {
                            console.log(`[WATCHDOG] Tripwire hit for ${asset} at ${(pnlPercent*100).toFixed(2)}% profit. Securing capital...`);
                            
                            const breakEvenSL = (openTrade.side || '').toUpperCase() === 'BUY' ? openTrade.entry_price * 1.001 : openTrade.entry_price * 0.999;
                            const safeBreakEvenSL = parseFloat((Math.round(breakEvenSL / tickSize) * tickSize).toFixed(4));
                            
                            if (openOrders.length > 0) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                                openOrders = []; 
                                // 🟢 THE FIX: 2-second exchange clearing breath
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }

                            const updatedReason = `${openTrade.reason || ''}\n\n[TRIPWIRE_ACTIVATED]: Profit reached ${(pnlPercent*100).toFixed(2)}%. SL moved to Break-Even.`;
                            await supabase.from('trade_logs').update({ sl_price: safeBreakEvenSL, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.sl_price = safeBreakEvenSL;
                            openTrade.reason = updatedReason;

                            await pingHermes({
                                asset: asset, 
                                mode: "TRIPWIRE_HIT",
                                message: `TRIPWIRE HIT! Trade is currently at ${(pnlPercent*100).toFixed(2)}% profit. Stop Loss has been automatically moved to break-even to secure capital. Review the live tape and Macro levels. Output action "HOLD" if the trend is still explosive, or "CLOSE" to secure profit now.`,
                                openTrade: openTrade,
                                strategy_id: openTrade.strategy_id,
                                macro_tf: params.macro_tf || 'ONE_HOUR',
                                trigger_tf: params.trigger_tf || 'THIRTY_MINUTE',
                                previous_thesis: configData?.active_thesis
                            });
                        }

                        if (trailStep > 0 && trailActivation > 0 && pnlPercent >= trailActivation) {
                            const dynamicSL = (openTrade.side || '').toUpperCase() === 'BUY' ? currentPrice * (1 - trailStep) : currentPrice * (1 + trailStep);
                            const safeDynamicSL = parseFloat((Math.round(dynamicSL / tickSize) * tickSize).toFixed(4));
                            
                            let shouldMoveSL = false;
                            if ((openTrade.side || '').toUpperCase() === 'BUY' && safeDynamicSL > openTrade.sl_price) shouldMoveSL = true;
                            if ((openTrade.side || '').toUpperCase() === 'SELL' && safeDynamicSL < openTrade.sl_price && openTrade.sl_price !== 0) shouldMoveSL = true;
                            
                            const diff = Math.abs(safeDynamicSL - openTrade.sl_price);
                            if (shouldMoveSL && diff > (tickSize * 10)) {
                                console.log(`[WATCHDOG] Trailing SL triggered for ${asset}. Moving SL up to $${safeDynamicSL}`);
                                
                                if (openOrders.length > 0) {
                                    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                    await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                                    openOrders = []; 
                                    // 🟢 THE FIX: 2-second exchange clearing breath
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                }

                                await supabase.from('trade_logs').update({ sl_price: safeDynamicSL }).eq('id', openTrade.id);
                                openTrade.sl_price = safeDynamicSL; 
                            }
                        }
                    }

                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at || Date.now()).getTime()) / 60000;
                        let totalAllowedMinutes = 15; 
                        const initialMatch = openTrade.reason?.match(/Fill:\s*(\d+)m/i);
                        if (initialMatch) totalAllowedMinutes = parseInt(initialMatch[1]);

                        if (minutesOpen > totalAllowedMinutes && !openTrade.reason?.includes('[HERMES_NOTIFIED]')) {
                            console.log(`[WATCHDOG] Stale limit detected on ${asset}. Waking Hermes Agent...`);
                            await pingHermes({
                                asset: asset, mode: "PENDING_REVIEW",
                                message: `Your limit order for ${asset} at $${openTrade.entry_price} has sat unfilled for ${Math.round(minutesOpen)}m. Current price is $${currentPrice}. Use get_market_state to evaluate if you should hold, adjust, or cancel.`
                            });
                            await supabase.from('trade_logs').update({ reason: `${openTrade.reason || ''}\n\n[HERMES_NOTIFIED]: Reviewing Stale Limit` }).eq('id', openTrade.id);
                        }
                        continue; 
                    }

                    if (!activePosition && !entryOrderExists) {
                        let wasCanceled = false; let wasFilled = false;
                        let exactExitPrice = currentPrice;
                        let assumedReason = 'MANUAL_EXCHANGE_CLOSE';

                        const histPath = `/api/v3/brokerage/orders/historical/batch?order_status=CANCELLED&product_id=${coinbaseProduct}`;
                        const fillPath = `/api/v3/brokerage/orders/historical/batch?order_status=FILLED&product_id=${coinbaseProduct}`;
                        
                        const [histResp, fillResp] = await Promise.all([
                            fetch(`https://api.coinbase.com${histPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', histPath, apiKeyName, apiSecret)}` } }),
                            fetch(`https://api.coinbase.com${fillPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', fillPath, apiKeyName, apiSecret)}` } })
                        ]);

                        if (histResp.ok) {
                            const histData = await histResp.json();
                            wasCanceled = histData.orders?.some(o => o.client_order_id === entryClientId || ((o.side || '').toUpperCase() === (openTrade.side || '').toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2)));
                        }
                        
                        if (fillResp.ok) {
                            const fillData = await fillResp.json();
                            const filledOco = fillData.orders?.find(o => o.client_order_id === ocoClientId);
                            
                            const closingSide = (openTrade.side || 'BUY').toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
                            
                            if (filledOco) {
                                wasFilled = true;
                                exactExitPrice = parseFloat(filledOco.average_filled_price || filledOco.order_configuration?.trigger_bracket_gtc?.limit_price || filledOco.order_configuration?.trigger_bracket_gtc?.stop_trigger_price || currentPrice);
                            } else {
                                const legacyFill = fillData.orders?.find(o => 
                                    (o.side || '').toUpperCase() === closingSide && 
                                    (
                                        (openTrade.tp_price && Math.abs(parseFloat(o.average_filled_price || 0) - openTrade.tp_price) < (tickSize * 50)) ||
                                        (openTrade.sl_price && Math.abs(parseFloat(o.average_filled_price || 0) - openTrade.sl_price) < (tickSize * 50))
                                    )
                                );
                                
                                const fallbackFill = fillData.orders?.find(o => (o.side || '').toUpperCase() === closingSide);

                                if (legacyFill) {
                                    wasFilled = true;
                                    exactExitPrice = parseFloat(legacyFill.average_filled_price || currentPrice);
                                } else if (fallbackFill) {
                                    wasFilled = true;
                                    exactExitPrice = parseFloat(fallbackFill.average_filled_price || currentPrice);
                                }
                            }
                        }

                        if (!wasCanceled && !wasFilled) {
                            const minutesOpen = (Date.now() - new Date(openTrade.created_at || Date.now()).getTime()) / 60000;
                            if (openTrade.order_type === 'LIMIT' && minutesOpen < 5) {
                                wasCanceled = true;
                            } else {
                                console.log(`[WATCHDOG BRUTE FORCE] Position missing for ${asset}. Tags wiped. Assuming manual UI close.`);
                                wasFilled = true;
                                exactExitPrice = currentPrice; 
                                assumedReason = 'MANUAL_UI_INTERVENTION (TAGS_WIPED)';
                            }
                        }

                        if (wasCanceled || (openTrade.order_type === 'LIMIT' && !wasFilled)) {
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: LIMIT_CANCELED_BY_EXCHANGE_OR_AGENT` : 'LIMIT_CANCELED_BY_AGENT';
                            const safeExitPrice = parseFloat(openTrade.entry_price) || 0;
                            
                            await supabase.from('trade_logs').update({ exit_price: safeExitPrice, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            
                            await supabase.from('scan_results').insert([{ strategy: openTrade.strategy_id || 'MANUAL', asset: asset, status: 'CANCELED', telemetry: { macro_regime_oracle: `ORDER CANCELED`, oracle_reasoning: updatedReason, open_position: "NONE" } }]);

                            const chartUrl = await buildWatchdogChart(asset, currentPrice, apiKeyName, apiSecret, openTrade);
                            await sendDiscordAlert({ title: `⏳ Limit Order Canceled: ${asset}`, description: `Removed from Exchange manually.`, color: 16776960, imageUrl: chartUrl });
                            
                            try {
                                const hermesEndpoint = process.env.HERMES_WEBHOOK_URL || 'http://localhost:8000/api/wake';
                                const autopsyUrl = hermesEndpoint.replace('/wake', '/autopsy');
                                await fetch(autopsyUrl, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ asset: asset, entry_price: safeExitPrice, exit_price: safeExitPrice, pnl: "0.0000", rolling_ledger: updatedReason, trigger: 'LIMIT_CANCELED' })
                                });
                            } catch (autopsyErr) { console.error("[WATCHDOG AUTOPSY TRIGGER FAULT]:", autopsyErr.message); }

                            continue; 
                        } else {
                            if (openOrders.length > 0) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                            }

                            if (wasFilled && openTrade.tp_price && openTrade.sl_price && assumedReason !== 'MANUAL_UI_INTERVENTION (TAGS_WIPED)') {
                                const distToTp = Math.abs(exactExitPrice - openTrade.tp_price);
                                const distToSl = Math.abs(exactExitPrice - openTrade.sl_price);
                                
                                if (distToTp < distToSl) { assumedReason = 'TAKE_PROFIT (NATIVE_SYNC)'; } 
                                else { assumedReason = 'STOP_LOSS (NATIVE_SYNC)'; }
                            }

                            const safeEntryPrice = parseFloat(openTrade.entry_price) || 0;
                            const safeExitPrice = parseFloat(exactExitPrice) || parseFloat(currentPrice) || 0;
                            const safeQty = parseFloat(openTrade.qty) || 1;
                            const rawPnl = (openTrade.side || '').toUpperCase() === 'BUY' ? (safeExitPrice - safeEntryPrice) * safeQty * multiplier : (safeEntryPrice - safeExitPrice) * safeQty * multiplier;
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${assumedReason}` : assumedReason;
                            
                            const { error: updateErr } = await supabase.from('trade_logs').update({ exit_price: safeExitPrice, pnl: parseFloat(rawPnl.toFixed(4)), exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            
                            if (updateErr) {
                                console.error("[TRADE LOG UPDATE FAILED]:", updateErr.message);
                            } else {
                                await supabase.from('scan_results').insert([{ strategy: openTrade.strategy_id || 'MANUAL', asset: asset, status: 'CLOSED', telemetry: { macro_regime_oracle: `POSITION CLOSED`, oracle_reasoning: updatedReason, open_pnl: rawPnl.toFixed(4), open_position: "NONE" } }]);
                            }

                            const chartUrl = await buildWatchdogChart(asset, currentPrice, apiKeyName, apiSecret, openTrade);

                            const entryText = safeEntryPrice ? `\n**Entry Price:** $${safeEntryPrice}` : '';
                            const tpText = openTrade.tp_price ? `\n**Target TP:** $${openTrade.tp_price}` : '';
                            const slText = openTrade.sl_price ? `\n**Target SL:** $${openTrade.sl_price}` : '';

                            await sendDiscordAlert({ 
                                title: `🏁 Position Sync: ${asset}`, 
                                description: `**Trigger:** ${assumedReason}\n**Realized PnL:** $${rawPnl.toFixed(4)}${entryText}${tpText}${slText}`, 
                                color: rawPnl >= 0 ? 5763719 : 15548997, 
                                imageUrl: chartUrl 
                            });

                            try {
                                const hermesEndpoint = process.env.HERMES_WEBHOOK_URL || 'http://localhost:8000/api/wake';
                                const autopsyUrl = hermesEndpoint.replace('/wake', '/autopsy');
                                await fetch(autopsyUrl, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ asset: asset, entry_price: safeEntryPrice, exit_price: safeExitPrice, pnl: rawPnl.toFixed(4), rolling_ledger: updatedReason, trigger: assumedReason })
                                });
                            } catch (autopsyErr) { console.error("[WATCHDOG AUTOPSY TRIGGER FAULT]:", autopsyErr.message); }

                            continue; 
                        }
                    }

                    if (activePosition) {
                        const hasBracket = openOrders.some(o => o.client_order_id === ocoClientId || o.order_configuration?.trigger_bracket_gtc || o.client_order_id?.startsWith('nx_wd_oco_'));

                        if (!hasBracket && openTrade.tp_price && openTrade.sl_price) {
                            const closingSide = (openTrade.side || '').toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
                            const orderQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                            const safeSlPrice = (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(4);
                            const safeTpPrice = (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(4);

                            console.log(`[WATCHDOG] Missing OCO Brackets for ${asset}. Deploying deterministic safety net...`);
                            const executePath = '/api/v3/brokerage/orders';
                            
                            const dynamicSafetyNetId = `nx_wd_oco_${Date.now()}`;
                            
                            const ocoPayload = {
                                client_order_id: dynamicSafetyNetId, product_id: coinbaseProduct, side: closingSide,
                                order_configuration: { trigger_bracket_gtc: { limit_price: safeTpPrice, stop_trigger_price: safeSlPrice, base_size: orderQty.toString() } }
                            };
                            
                            try {
                                const ocoResp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                
                                // 🟢 THE FIX: Wrap JSON parse in try/catch to shield from Cloudflare HTML errors
                                let ocoResult;
                                try {
                                    ocoResult = await ocoResp.json();
                                } catch (jsonErr) {
                                    console.error(`[WATCHDOG OCO FAULT] Exchange returned invalid data. Delaying bracket deployment...`);
                                    continue; 
                                }
                                
                                if (!ocoResp.ok || ocoResult.success === false) {
                                    const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
                                    console.error(`[WATCHDOG BRACKET REJECT] OCO Failed:`, ocoErrMsg);
                                    await sendDiscordAlert({ title: `⚠️ Watchdog Bracket Failed: ${asset}`, description: `**Action:** Attempted to deploy missing TP/SL protection!\n**Details:** ${ocoErrMsg}`, color: 15548997 });
                                } else {
                                    console.log(`[WATCHDOG] Successfully deployed new brackets for ${asset}.`);
                                    await sendDiscordAlert({ title: `🛡️ Watchdog Safety Net Deployed: ${asset}`, description: `**Take Profit:** $${safeTpPrice}\n**Stop Loss:** $${safeSlPrice}\n**Status:** OCO Brackets successfully attached to naked position.`, color: 10181046 });
                                }
                            } catch (error) {
                                console.error("[WATCHDOG BRACKET FATAL]:", error.message);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("[WATCHDOG FAULT]:", err.message);
        }
    }, 5000); 
}