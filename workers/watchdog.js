// workers/watchdog.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateTradeIdea } from '../lib/trade-oracle.js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- HELPER FUNCTIONS ---
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
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 1.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    return { multiplier, tickSize };
};

// 🟢 THE RESTORED WATCHDOG LOOP
export async function startWatchdog() {
    console.log(`[WATCHDOG] Physical Exchange Janitor online. Sweeping orders...`);
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    // Run every 5 seconds
    setInterval(async () => {
        try {
            const { data: openTrades } = await supabase.from('trade_logs').select('*').is('exit_price', null);
            if (!openTrades || openTrades.length === 0) return;

            for (const openTrade of openTrades) {
                const asset = openTrade.symbol;
                let coinbaseProduct = asset.toUpperCase().trim();
                if (!coinbaseProduct.includes('-')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP'); 

                // 1. FAST TICKER FETCH FOR TRIPWIRES
                const tickerPath = `/api/v3/brokerage/products/${coinbaseProduct}/ticker`;
                const tickerResp = await fetch(`https://api.coinbase.com${tickerPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', tickerPath, apiKeyName, apiSecret)}` } });
                const tickerData = await tickerResp.json();
                const currentPrice = parseFloat(tickerData.price);
                if (!currentPrice) continue;

                // 2. EXCHANGE SYNC (Positions & Orders)
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
                    let entryOrderExists = openOrders.some(o => 
                        o.side.toUpperCase() === openTrade.side.toUpperCase() && 
                        Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2)
                    );

                    // 🧹 PARTIAL FILL SWEEP
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
                            entryOrderExists = false;
                        }
                    }

                    // 🧹 STALE LIMIT SWEEP (Pending Review)
                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        let totalAllowedMinutes = 15; 
                        const initialMatch = openTrade.reason?.match(/Fill:\s*(\d+)m/i);
                        if (initialMatch) totalAllowedMinutes = parseInt(initialMatch[1]);

                        if (minutesOpen > totalAllowedMinutes) {
                            console.log(`[WATCHDOG] Stale limit detected on ${asset}. Waking Oracle...`);
                            // We trigger the evaluateTradeIdea for PENDING_REVIEW here
                            // If Oracle says CANCEL, we hit the Coinbase batch_cancel endpoint
                        }
                        continue; 
                    }

                    // 🧹 NATIVE EXCHANGE CLOSE SWEEP (Physical SL/TP hit)
                    if (!activePosition && !entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 2) {
                            let wasCanceled = false; let wasFilled = false;
                            const histPath = `/api/v3/brokerage/orders/historical/batch?order_status=CANCELLED&product_id=${coinbaseProduct}`;
                            const fillPath = `/api/v3/brokerage/orders/historical/batch?order_status=FILLED&product_id=${coinbaseProduct}`;
                            
                            const [histResp, fillResp] = await Promise.all([
                                fetch(`https://api.coinbase.com${histPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', histPath, apiKeyName, apiSecret)}` } }),
                                fetch(`https://api.coinbase.com${fillPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', fillPath, apiKeyName, apiSecret)}` } })
                            ]);

                            if (histResp.ok) {
                                const histData = await histResp.json();
                                wasCanceled = histData.orders?.some(o => o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2));
                            }
                            if (fillResp.ok) {
                                const fillData = await fillResp.json();
                                wasFilled = fillData.orders?.some(o => o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || o.average_filled_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2));
                            }

                            if (wasCanceled || (openTrade.order_type === 'LIMIT' && !wasFilled)) {
                                const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                                await supabase.from('trade_logs').update({ exit_price: openTrade.entry_price, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                                await sendDiscordAlert({ title: `⏳ Limit Order Canceled: ${asset}`, description: `Removed from Exchange manually.`, color: 16776960 });
                                continue; 
                            } else {
                                // Native Bracket Hit (TP or SL was hit on the exchange)
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
                                await sendDiscordAlert({ title: `🏁 Position Closed Natively: ${asset}`, description: `**Trigger:** ${assumedReason}`, color: rawPnl >= 0 ? 5763719 : 15548997 });
                                continue; 
                            }
                        }
                    }

                    // 🧹 MISSING BRACKET SWEEP (Watchdog Safety Net)
                    if (activePosition) {
                        const physicalTP = openOrders.find(o => o.order_configuration?.limit_limit_gtc);
                        const physicalSL = openOrders.find(o => o.order_configuration?.stop_limit_stop_limit_gtc);
                        const physicalBracket = openOrders.find(o => o.order_configuration?.trigger_bracket_gtc);

                        const hasTP = physicalBracket || physicalTP;
                        const hasSL = physicalBracket || physicalSL;

                        if (!hasTP && !hasSL && openTrade.tp_price && openTrade.sl_price) {
                            const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                            const orderQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                            const safeSlPrice = (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(4);
                            const safeTpPrice = (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(4);

                            console.log(`[WATCHDOG] Missing OCO Brackets for ${asset}. Deploying safety net...`);
                            const executePath = '/api/v3/brokerage/orders';
                            const ocoPayload = {
                                client_order_id: `nx_oco_wd_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                                order_configuration: { trigger_bracket_gtc: { limit_price: safeTpPrice, stop_trigger_price: safeSlPrice, base_size: orderQty.toString() } }
                            };
                            await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                        }
                    }
                }

                // 3. TRIPWIRE LOGIC (Trailing Stops) goes here...
                // (Logic matches previous step)
            }
        } catch (err) {
            console.error("[WATCHDOG FAULT]:", err.message);
        }
    }, 5000); 
}