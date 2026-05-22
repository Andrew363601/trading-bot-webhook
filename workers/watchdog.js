// workers/watchdog.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { buildRadarChartUrl } from '../lib/discord-chart.js'; 
import { cleanupOldScanResults } from '../lib/cleanup-scan-results.js'; 
import { cleanupOldAgentLogs } from '../lib/cleanup-agent-logs.js'; 

import WebSocket from 'ws'; 

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { 
    global: { WebSocket: WebSocket },
    realtime: { transport: WebSocket }
  }
);

async function sendDiscordAlert(tenant_id, { title, description, color, fields = [], imageUrl = null }) {
    const { data: settings, error: settingsError } = await supabase
        .from('tenant_settings')
        .select('notification_webhook_url')
        .eq('tenant_id', tenant_id)
        .single();

    if (settingsError) {
        console.error("[DISCORD ALERT ERROR]: Failed to fetch webhook URL for tenant:", settingsError.message);
        return;
    }
    const webhookUrl = settings?.notification_webhook_url;

    if (!webhookUrl) {
        console.warn("[DISCORD ALERT WARNING]: No Discord webhook URL configured for tenant", tenant_id);
        return;
    }
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

/**
 * Maps any trading symbol (futures, options, CFM) to its public spot equivalent.
 * Example: ETP-20DEC30-CDE -> ETH-USD, SOL-PERP-INTX -> SOL-USD
 */
const getSpotSymbol = (symbol) => {
    const base = symbol.split('-')[0].toUpperCase();
    const spotMap = {
        'ETP': 'ETH', 'ETH': 'ETH',
        'BIT': 'BTC', 'BIP': 'BTC', 'BTC': 'BTC',
        'SLP': 'SOL', 'SOL': 'SOL',
        'DOP': 'DOGE', 'DOGE': 'DOGE',
        'LCP': 'LTC', 'LTC': 'LTC',
        'AVP': 'AVAX', 'AVAX': 'AVAX',
        'LNP': 'LINK', 'LINK': 'LINK',
        'XPP': 'XRP', 'XRP': 'XRP'
    };
    return `${spotMap[base] || base}-USD`;
};

async function buildWatchdogChart(symbol, currentPrice, apiKeyName, apiSecret, openTrade = null, tpPrice = null, slPrice = null) {
    try {
        let telemetry = {};
        const { data: scanData } = await supabase.from('scan_results').select('telemetry').eq('asset', symbol).order('created_at', { ascending: false }).limit(1);
        if (scanData && scanData.length > 0) telemetry = scanData[0].telemetry || {};

        // 🟢 PUBLIC CANDLE API: Use unauthenticated exchange API with spot symbol mapping
        const end = Math.floor(Date.now() / 1000);
        const start = end - (300 * 50); 
        const publicProduct = getSpotSymbol(symbol);
        const candleResp = await fetch(`https://api.exchange.coinbase.com/products/${publicProduct}/candles?start=${start}&end=${end}&granularity=300`);
        let recentCandles = [];
        if (candleResp.ok) {
            const cData = await candleResp.json();
            recentCandles = (cData || []).map(c => ({ open: parseFloat(c[3] || c[4]), high: parseFloat(c[2]), low: parseFloat(c[1]), close: parseFloat(c[4]) })).reverse() || [];
        }
        
        return await buildRadarChartUrl({
            asset: symbol, candles: recentCandles, currentPrice: currentPrice,
            poc: telemetry.macro_poc, upperNode: telemetry.upper_macro_node, lowerNode: telemetry.lower_macro_node,
            tpPrice: tpPrice || openTrade?.tp_price,
            slPrice: slPrice || openTrade?.sl_price,
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

const heartbeatTracker = {};
const missingBracketTracker = {};
const keyFetchCooldown = {}; // tenantId -> timestamp of last key-fetch warning

export async function startWatchdog(tenantId) {
    await logAgentActivity(tenantId, "Watchdog", "N/A", "Watchdog worker started.", "WORKER_START");
    console.log(`[WATCHDOG-${tenantId}] Physical Exchange Janitor online. Sweeping orders...`);

    // Hourly cleanup of old scan_results (72h retention) and agent_session_logs (24h retention)
    setInterval(() => {
        cleanupOldScanResults();
        cleanupOldAgentLogs();
    }, 60 * 60 * 1000);
    // Run once immediately on startup
    cleanupOldScanResults();
    cleanupOldAgentLogs();

    setInterval(async () => {
        try {
            await logAgentActivity(tenantId, "Watchdog", "N/A", "Sweeping open trades and orders.", "SWEEP_START");
            const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('tenant_id', tenantId).is('exit_price', null);
            if (!openTrades || openTrades.length === 0) return;

            for (const openTrade of openTrades) {
                const asset = openTrade.symbol;
                
                const tradeAgeMs = Date.now() - new Date(openTrade.created_at || Date.now()).getTime();
                if (tradeAgeMs < 15000) {
                    await logAgentActivity(tenantId, "Watchdog", asset, `Trade ${openTrade.id} is pending exchange propagation (${Math.round(tradeAgeMs/1000)}s).`, "TRADE_PENDING");
                    console.log(`[WATCHDOG-${tenantId}] Trade ${openTrade.id} is pending exchange propagation (${Math.round(tradeAgeMs/1000)}s). Yielding...`);
                    continue; 
                }

                // Cleanup orphaned trades: if trade is > 60s old with no exchange confirmation, mark as failed
                // 🛡️ GUARD: Only clean up if trade was never-filled trades (no entry_price) or manually reopened ones
                // Trades with entry_price were successfully filled — skip cleanup, let LIVE monitoring handle them
                const wasManuallyReopened = openTrade.entry_price && !openTrade.exit_price && openTrade.exit_time !== null;
                if (tradeAgeMs > 60000 && openTrade.execution_mode === 'LIVE' && !openTrade.entry_price && !wasManuallyReopened) {
                    await logAgentActivity(tenantId, "Watchdog", asset, `Trade ${openTrade.id} has been pending for ${Math.round(tradeAgeMs/1000)}s without exchange confirmation. Cleaning up...`, "TRADE_CLEANUP");
                    console.log(`[WATCHDOG-${tenantId}] Trade ${openTrade.id} has been pending for ${Math.round(tradeAgeMs/1000)}s. Marking as failed.`);
                    const safeExitPrice = parseFloat(openTrade.entry_price) || 0;
                    if (safeExitPrice === 0) {
                        // Can't close a trade that never had a price — just log and skip
                        await logAgentActivity(tenantId, "Watchdog", asset, `Trade ${openTrade.id} has no entry_price. Cannot mark as failed.`, "TRADE_CLEANUP_SKIPPED");
                        continue;
                    }
                    await supabase.from('trade_logs').update({
                        exit_price: safeExitPrice,
                        pnl: 0,
                        exit_time: new Date().toISOString(),
                        reason: 'ORDER_FAILED'
                    }).eq('id', openTrade.id);
                    continue;
                }

                let coinbaseProduct = asset.toUpperCase().trim();
                if (!coinbaseProduct.includes('-')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP'); 

                // 🟢 PUBLIC TICKER: Use unauthenticated exchange API with spot symbol mapping
                const spotSymbol = getSpotSymbol(asset);
                const tickerResp = await fetch(`https://api.exchange.coinbase.com/products/${spotSymbol}/ticker`);
                
                let tickerData;
                try {
                    tickerData = await tickerResp.json();
                } catch (jsonErr) {
                    console.error(`[WATCHDOG API FAULT] Coinbase returned non-JSON data for ${asset}. Skipping tick...`);
                    continue; 
                }
                
                const currentPrice = parseFloat(tickerData.price || tickerData.bid || tickerData.ask);
                
                if (!currentPrice || isNaN(currentPrice)) {
                    continue;
                }

                const { multiplier, tickSize } = getAssetMetrics(coinbaseProduct);

                if (!openTrade.entry_price || openTrade.entry_price === 0) {
                    if (openTrade.execution_mode === 'LIVE') {
                     await logAgentActivity(tenantId, "Watchdog", asset, `Missing entry price for trade ${openTrade.id}. Attempting to self-heal.`, "SELF_HEAL_START");
                     console.log(`[WATCHDOG] Missing entry price detected for trade ${openTrade.id}. Attempting to self-heal...`);
                     const fillPath = `/api/v3/brokerage/orders/historical/batch?order_status=FILLED&product_id=${coinbaseProduct}`;
                     try {
                         const { retrieveAPIKey } = await import('../lib/secrets-manager.js');
                         const healSecrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
                         if (healSecrets.apiKey && healSecrets.apiSecret) {
                             const fillResp = await fetch(`https://api.coinbase.com${fillPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', fillPath, healSecrets.apiKey, healSecrets.apiSecret)}` } });
                             if (fillResp.ok) {
                                 const fillData = await fillResp.json();
                                 const entryOrder = fillData.orders?.find(o => o.client_order_id === `nx_entry_${openTrade.id}`);
                                 if (entryOrder && entryOrder.average_filled_price) {
                                     const trueEntryPrice = parseFloat(entryOrder.average_filled_price);
                                     await supabase.from('trade_logs').update({ entry_price: trueEntryPrice }).eq('id', openTrade.id);
                                     openTrade.entry_price = trueEntryPrice;
                                     await logAgentActivity(tenantId, "Watchdog", asset, `Successfully healed entry price for trade ${openTrade.id} to $${trueEntryPrice}`, "SELF_HEAL_SUCCESS");
                                     console.log(`[WATCHDOG] Successfully healed entry price for trade ${openTrade.id} to $${trueEntryPrice}`);
                                 }
                             }
                         }
                     } catch(e) { console.error("[WATCHDOG SELF-HEAL FAULT]", e.message); }
                    } else {
                     await logAgentActivity(tenantId, "Watchdog", asset, `Missing entry price for trade ${openTrade.id}. No tenant keys available for self-heal.`, "SELF_SKIP");
                     console.log(`[WATCHDOG] Missing entry price for trade ${openTrade.id}. Skipping self-heal (PAPER trade or no keys).`);
                    }
                     
                     if (!openTrade.entry_price || openTrade.entry_price === 0) continue; 
                }

                let activePosition = null;
                let openOrders = [];
                
                if (openTrade.execution_mode === 'LIVE') {
                    // 🔒 LAZY KEY FETCH: Only retrieve tenant keys when processing a LIVE trade
                    let tenantLiveKeys = null;
                    try {
                        const { retrieveAPIKey } = await import('../lib/secrets-manager.js');
                        const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
                        if (secrets.apiKey && secrets.apiSecret) {
                            tenantLiveKeys = secrets;
                        } else {
                            throw new Error('Empty keys returned');
                        }
                    } catch (e) {
                        const lastWarn = keyFetchCooldown[tenantId] || 0;
                        if (Date.now() - lastWarn > 300000) {
                            console.warn(`[WATCHDOG-${tenantId}] Cannot retrieve tenant API keys: ${e.message}. LIVE operations disabled. Next warning in 5 min.`);
                            keyFetchCooldown[tenantId] = Date.now();
                        }
                        continue;
                    }

                    const liveApiKey = tenantLiveKeys.apiKey;
                    const liveApiSecret = tenantLiveKeys.apiSecret;

                    const posPath = '/api/v3/brokerage/cfm/positions';
                    const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
                    
                    const [posResp, orderResp] = await Promise.all([
                        fetch(`https://api.coinbase.com${posPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', posPath, liveApiKey, liveApiSecret)}` } }),
                        fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', orderPath, liveApiKey, liveApiSecret)}` } })
                    ]);

                    if (posResp.ok) {
                        const posData = await posResp.json();
                        activePosition = posData.positions?.find(p => p.product_id === coinbaseProduct && Math.abs(parseFloat(p.number_of_contracts)) > 0);
                    }
                    if (orderResp.ok) {
                        const orderData = await orderResp.json();
                        openOrders = orderData.orders || [];
                    }

                    let entryClientId = `nx_entry_${openTrade.id}`;
                    let ocoClientId = `nx_oco_${openTrade.id}`;

                    let entryOrderExists = openOrders.some(o => 
                        o.client_order_id === entryClientId || 
                        (o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2))
                    );

                    if (activePosition && entryOrderExists) {
                        // 🟢 LIVE TRADE CONFIRMED: First time we detect an active position on exchange
                        if (!heartbeatTracker[`${openTrade.id}_confirmed`]) {
                            heartbeatTracker[`${openTrade.id}_confirmed`] = true;
                            const activeQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                            await sendDiscordAlert(tenantId, {
                                title: `🟢 LIVE Trade Confirmed: ${asset}`,
                                description: `**Position Size:** ${activeQty} contracts\n**Entry:** $${openTrade.entry_price || 'awaiting fill'}\n**Trade ID:** ${openTrade.id}`,
                                color: 5763719
                            });
                            await logAgentActivity(tenantId, "Watchdog", asset, `LIVE trade ${openTrade.id} confirmed on exchange with ${activeQty} contracts.`, "LIVE_TRADE_CONFIRMED");
                        }

                        if (activeQty < expectedQty) {
                            const targetOrder = openOrders.find(o => o.client_order_id === entryClientId || (o.side.toUpperCase() === openTrade.side.toUpperCase() && Math.abs(parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price || 0) - parseFloat(openTrade.entry_price)) < (tickSize * 2)));
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, liveApiKey, liveApiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] }) });
                            }
                            const updatedReason = `${openTrade.reason || ''}\n\n[PARTIAL FILL]: Market moved. Remaining ${expectedQty - activeQty} contracts canceled.`;
                            await supabase.from('trade_logs').update({ qty: activeQty, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.qty = activeQty;
                            entryOrderExists = false;
                        }
                    }

                    if (activePosition && openTrade.entry_price) {
                        const { data: configData } = await supabase.from('strategy_config').select('*').eq('tenant_id', tenantId).ilike('strategy', openTrade.strategy_id).eq('asset', asset).maybeSingle();
                        const params = configData?.parameters || {};
                        
                        const leverage = parseFloat(openTrade.leverage || 1);
                        const rawPriceMove = openTrade.side === 'BUY' 
                            ? (currentPrice - openTrade.entry_price) / openTrade.entry_price 
                            : (openTrade.entry_price - currentPrice) / openTrade.entry_price;
                        
                        const pnlPercent = rawPriceMove * leverage;
                            
                        const tripwire = parseFloat(params.tripwire_percent || 0);
                        const trailStep = parseFloat(params.trail_step_percent || 0);
                        const trailActivation = parseFloat(params.trail_activation_percent || params.tripwire_percent || 0);

                        const now = Date.now();
                        if (!heartbeatTracker[openTrade.id] || now - heartbeatTracker[openTrade.id] >= 60000) {
                            await logAgentActivity(tenantId, "Watchdog", asset, `Heartbeat: Live ROE: ${(pnlPercent * 100).toFixed(2)}% | Tripwire: ${(tripwire * 100).toFixed(2)}%.`, "HEARTBEAT");
                            console.log(`[WATCHDOG RADAR] Asset: ${asset} | Live ROE: ${(pnlPercent * 100).toFixed(2)}% | Tripwire: ${(tripwire * 100).toFixed(2)}%`);
                            heartbeatTracker[openTrade.id] = now;
                        }

                        if (tripwire > 0 && pnlPercent >= tripwire && !openTrade.reason?.includes('[TRIPWIRE_ACTIVATED]')) {
                            // 🛡️ GUARD: Skip tripwire if the agent recently adjusted TP/SL to avoid race condition
                            const recentAdjust = openTrade.reason?.includes('[ADJUST_TP_SL]');
                            const recentlyUpdated = openTrade.updated_at && (Date.now() - new Date(openTrade.updated_at).getTime()) < 60000;
                            if (recentAdjust || recentlyUpdated) {
                                await logAgentActivity(tenantId, "Watchdog", asset, `Tripwire skipped for ${asset} — ADJUST_TP_SL was recently applied. Letting agent-managed brackets stand.`, "TRIPWIRE_SKIPPED");
                                console.log(`[WATCHDOG] Tripwire skipped for ${asset} — recent ADJUST_TP_SL detected.`);
                            } else {
                            await logAgentActivity(tenantId, "Watchdog", asset, `Tripwire hit! Profit at ${(pnlPercent*100).toFixed(2)}%. Securing capital.`, "TRIPWIRE_HIT");
                            console.log(`[WATCHDOG] Tripwire hit for ${asset} at ${(pnlPercent*100).toFixed(2)}% profit. Securing capital...`);
                            
                            const breakEvenSL = openTrade.side === 'BUY' ? openTrade.entry_price * 1.001 : openTrade.entry_price * 0.999;
                            const safeBreakEvenSL = parseFloat((Math.round(breakEvenSL / tickSize) * tickSize).toFixed(4));
                            
                            if (openOrders.length > 0) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, liveApiKey, liveApiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                                openOrders = []; 
                            }

                            const updatedReason = `${openTrade.reason || ''}\n\n[TRIPWIRE_ACTIVATED]: Profit reached ${(pnlPercent*100).toFixed(2)}%. SL moved to Break-Even.`;
                            await supabase.from('trade_logs').update({ sl_price: safeBreakEvenSL, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.sl_price = safeBreakEvenSL;
                            openTrade.reason = updatedReason;

                            // 📊 CHART: Tripwire activated — send chart with new break-even SL
                            const tripwireChartUrl = await buildWatchdogChart(asset, currentPrice, liveApiKey, liveApiSecret, openTrade, null, safeBreakEvenSL);
                            await sendDiscordAlert(tenantId, {
                                title: `🛡️ Tripwire Activated: ${asset}`,
                                description: `**Action:** SL moved to Break-Even at $${safeBreakEvenSL}\n**Profit at Trigger:** ${(pnlPercent*100).toFixed(2)}%`,
                                color: 10181046,
                                imageUrl: tripwireChartUrl
                            });

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
                            }

                        if (trailStep > 0 && trailActivation > 0 && pnlPercent >= trailActivation) {
                            const assetTrailStep = trailStep / leverage; 
                            const dynamicSL = openTrade.side === 'BUY' ? currentPrice * (1 - assetTrailStep) : currentPrice * (1 + assetTrailStep);
                            const safeDynamicSL = parseFloat((Math.round(dynamicSL / tickSize) * tickSize).toFixed(4));
                            
                            let shouldMoveSL = false;
                            if (openTrade.side === 'BUY' && safeDynamicSL > openTrade.sl_price) shouldMoveSL = true;
                            if (openTrade.side === 'SELL' && safeDynamicSL < openTrade.sl_price && openTrade.sl_price !== 0) shouldMoveSL = true;
                            
                            const diff = Math.abs(safeDynamicSL - openTrade.sl_price);
                            if (shouldMoveSL && diff > (tickSize * 10)) {
                                await logAgentActivity(tenantId, "Watchdog", asset, `Trailing SL triggered. Moving SL to $${safeDynamicSL}.`, "TRAILING_SL_MOVE");
                                console.log(`[WATCHDOG] Trailing SL triggered for ${asset}. Moving SL up to $${safeDynamicSL}`);

                                if (openOrders.length > 0) {
                                    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                    await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, liveApiKey, liveApiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                                    openOrders = []; 
                                }

                                await supabase.from('trade_logs').update({ sl_price: safeDynamicSL }).eq('id', openTrade.id);
                                openTrade.sl_price = safeDynamicSL;

                                // 📊 CHART: Trailing SL moved — send chart with new SL
                                const trailChartUrl = await buildWatchdogChart(asset, currentPrice, liveApiKey, liveApiSecret, openTrade, null, safeDynamicSL);
                                await sendDiscordAlert(tenantId, {
                                    title: `🎯 Trailing SL Updated: ${asset}`,
                                    description: `**New SL:** $${safeDynamicSL}\n**Direction:** ${openTrade.side === 'BUY' ? 'Up' : 'Down'}`,
                                    color: 10181046,
                                    imageUrl: trailChartUrl
                                });
                            }
                        }
                    }

                    // 🟢 FALLBACK: Log that LIVE trade exists in DB even if no exchange position found
                    if (!activePosition) {
                        const now = Date.now();
                        if (!heartbeatTracker[openTrade.id + '_monitor'] || now - heartbeatTracker[openTrade.id + '_monitor'] >= 120000) {
                            await logAgentActivity(tenantId, "Watchdog", asset, `Monitoring LIVE trade ${openTrade.id} — no active position on exchange yet.`, "INFO");
                            heartbeatTracker[openTrade.id + '_monitor'] = now;
                        }
                    }

                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at || Date.now()).getTime()) / 60000;
                        let totalAllowedMinutes = 15; 
                        const initialMatch = openTrade.reason?.match(/Fill:\s*(\d+)m/i);
                        if (initialMatch) totalAllowedMinutes = parseInt(initialMatch[1]);

                        if (minutesOpen > totalAllowedMinutes && !openTrade.reason?.includes('[HERMES_NOTIFIED]')) {
                            await logAgentActivity(tenantId, "Watchdog", asset, `Stale limit order for ${asset} detected (${Math.round(minutesOpen)}m unfilled). Waking Hermes Agent for review.`, "STALE_ORDER_DETECTED");
                            console.log(`[WATCHDOG] Stale limit detected on ${asset}. Waking Hermes Agent...`);
                            await pingHermes({
                                asset: asset, mode: "PENDING_REVIEW",
                                message: `Your limit order for ${asset} at $${openTrade.entry_price} has sat unfilled for ${Math.round(minutesOpen)}m. Current price is $${currentPrice}. Use get_market_state to evaluate if you should hold, adjust, or cancel.`
                            });
                            await supabase.from('trade_logs').update({ reason: `${openTrade.reason || ''}\n\n[HERMES_NOTIFIED]: Reviewing Stale Limit` }).eq('id', openTrade.id);
                        }
                        continue; 
                    }

                    // 🛡️ GUARD: Skip auto-close if user manually reopened this trade
                    if (!activePosition && !entryOrderExists && openTrade.entry_price && !openTrade.exit_price && openTrade.exit_time !== null) {
                        await logAgentActivity(tenantId, "Watchdog", asset, `Trade ${openTrade.id} has no exchange position but exit_price was cleared by user. Monitoring without closing.`, "INFO");
                        continue;
                    }

                    if (!activePosition && !entryOrderExists) {
                        let wasCanceled = false; let wasFilled = false;
                        let exactExitPrice = currentPrice;
                        let assumedReason = 'MANUAL_EXCHANGE_CLOSE';

                        const histPath = `/api/v3/brokerage/orders/historical/batch?order_status=CANCELLED&product_id=${coinbaseProduct}`;
                        const fillPath = `/api/v3/brokerage/orders/historical/batch?order_status=FILLED&product_id=${coinbaseProduct}`;
                        
                        const [histResp, fillResp] = await Promise.all([
                            fetch(`https://api.coinbase.com${histPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', histPath, liveApiKey, liveApiSecret)}` } }),
                            fetch(`https://api.coinbase.com${fillPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', fillPath, liveApiKey, liveApiSecret)}` } })
                        ]);

                        if (histResp.ok) {
                            const histData = await histResp.json();
                            // 🟢 Strict ID Matching only
                            wasCanceled = histData.orders?.some(o => o.client_order_id === entryClientId);
                        }
                        
                        if (fillResp.ok) {
                            const fillData = await fillResp.json();
                            const closingSide = openTrade.side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
                            
                            // 🟢 THE FIX: Force strict chronological sorting so we grab the newest trade, not the oldest!
                            const sortedFills = (fillData.orders || []).sort((a, b) => new Date(b.created_time || 0).getTime() - new Date(a.created_time || 0).getTime());
                            
                            // 1. Search for the original OCO Bracket
                            let targetFill = sortedFills.find(o => o.client_order_id === ocoClientId);
                            
                            // 2. Search for the Watchdog's Safety Net Bracket
                            if (!targetFill) {
                                targetFill = sortedFills.find(o => o.client_order_id?.startsWith('nx_wd_oco_') && o.side.toUpperCase() === closingSide);
                                if (targetFill) assumedReason = 'WATCHDOG_SAFETY_NET_TRIGGERED';
                            }
                            
                            // 3. Search for a Hermes Market Sweep or Manual UI Close
                            if (!targetFill) {
                                targetFill = sortedFills.find(o => o.side.toUpperCase() === closingSide);
                                if (targetFill) assumedReason = 'HERMES_MARKET_SWEEP_OR_UI_CLOSE';
                            }
                            
                            if (targetFill) {
                                wasFilled = true;
                                // 🟢 THE FIX: Extract fill price with trigger-type awareness
                                // For stop-loss fills, prefer stop_trigger_price over limit_price (which is the TP)
                                const rawPrice = targetFill.average_filled_price || targetFill.order_configuration?.trigger_bracket_gtc?.stop_trigger_price || targetFill.order_configuration?.trigger_bracket_gtc?.limit_price || currentPrice;
                                exactExitPrice = parseFloat(rawPrice);
                                
                                // 🟢 SANITY CHECK: If we have TP/SL on the open trade, verify the exit price
                                // is within reasonable bounds of the triggered level
                                if (openTrade.tp_price && openTrade.sl_price) {
                                    const distToSl = Math.abs(exactExitPrice - openTrade.sl_price);
                                    const distToTp = Math.abs(exactExitPrice - openTrade.tp_price);
                                    const slCheck = assumedReason.includes('STOP_LOSS') || (distToSl < distToTp && rawPrice !== currentPrice);
                                    const tpCheck = assumedReason.includes('TAKE_PROFIT') || (distToTp < distToSl && rawPrice !== currentPrice);
                                    
                                    // If price seems wrong (both distances too large), fallback to the closer bracket
                                    if (slCheck && distToSl > tickSize * 50 && openTrade.sl_price) {
                                        console.log(`[WATCHDOG PRICE SANITY] Exit price $${exactExitPrice} far from SL $${openTrade.sl_price}. Using SL price as fallback.`);
                                        exactExitPrice = parseFloat(openTrade.sl_price);
                                    } else if (tpCheck && distToTp > tickSize * 50 && openTrade.tp_price) {
                                        console.log(`[WATCHDOG PRICE SANITY] Exit price $${exactExitPrice} far from TP $${openTrade.tp_price}. Using TP price as fallback.`);
                                        exactExitPrice = parseFloat(openTrade.tp_price);
                                    }
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
                            
                            // 🛡️ GUARD: Prevent zombie trades (exit_time without valid exit_price)
                            if (safeExitPrice <= 0) {
                                console.warn(`[WATCHDOG] Skipping trade close for ${openTrade.id}: exit_price would be ${safeExitPrice}`);
                                await logAgentActivity(tenantId, "Watchdog", asset, `Skipped close for trade ${openTrade.id}: invalid exit_price`, "TRADE_CLOSE_SKIPPED");
                                continue;
                            }
                            
                            await supabase.from('trade_logs').update({ exit_price: safeExitPrice, pnl: 0, exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            
                            await supabase.from('scan_results').insert([{ strategy: openTrade.strategy_id || 'MANUAL', asset: asset, status: 'CANCELED', telemetry: { macro_regime_oracle: `ORDER CANCELED`, oracle_reasoning: updatedReason, open_position: "NONE" } }]);

                            const cancelChartUrl = await buildWatchdogChart(asset, currentPrice, liveApiKey, liveApiSecret, openTrade);
                            await sendDiscordAlert(tenantId, { title: `⏳ Limit Order Canceled: ${asset}`, description: `Removed from Exchange manually.`, color: 16776960, imageUrl: cancelChartUrl });
                            await logAgentActivity(tenantId, "Watchdog", asset, `Limit order for ${asset} was canceled. Initiating autopsy.`, "ORDER_CANCELED");
                            
                            try {
                                const hermesEndpoint = process.env.HERMES_WEBHOOK_URL || 'http://localhost:8000/api/wake';
                                const autopsyUrl = hermesEndpoint.replace('/wake', '/autopsy');
                                await fetch(autopsyUrl, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ tenant_id: tenantId, asset: asset, entry_price: safeExitPrice, exit_price: safeExitPrice, pnl: "0.0000", rolling_ledger: updatedReason, trigger: 'LIMIT_CANCELED' })
                                });
                            } catch (autopsyErr) { console.error("[WATCHDOG AUTOPSY TRIGGER FAULT]:", autopsyErr.message); }

                            continue; 
                        } else {
                            if (openOrders.length > 0) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, liveApiKey, liveApiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) }) });
                            }

                            if (wasFilled && openTrade.tp_price && openTrade.sl_price && !assumedReason.includes('MANUAL_UI_INTERVENTION') && !assumedReason.includes('HERMES_MARKET_SWEEP')) {
                                const distToTp = Math.abs(exactExitPrice - openTrade.tp_price);
                                const distToSl = Math.abs(exactExitPrice - openTrade.sl_price);
                                
                                if (distToTp < distToSl) { assumedReason = 'TAKE_PROFIT (NATIVE_SYNC)'; } 
                                else { assumedReason = 'STOP_LOSS (NATIVE_SYNC)'; }
                            }

                            const safeEntryPrice = parseFloat(openTrade.entry_price) || 0;
                            const safeExitPrice = parseFloat(exactExitPrice) || parseFloat(currentPrice) || 0;
                            
                            // 🛡️ GUARD: Prevent zombie trades (exit_time without valid exit_price)
                            if (safeExitPrice <= 0) {
                                console.warn(`[WATCHDOG] Skipping trade close for ${openTrade.id}: exit_price would be ${safeExitPrice}`);
                                await logAgentActivity(tenantId, "Watchdog", asset, `Skipped close for trade ${openTrade.id}: invalid exit_price`, "TRADE_CLOSE_SKIPPED");
                                continue;
                            }
                            
                            const safeQty = parseFloat(openTrade.qty) || 1;
                            const rawPnl = openTrade.side === 'BUY' ? (safeExitPrice - safeEntryPrice) * safeQty * multiplier : (safeEntryPrice - safeExitPrice) * safeQty * multiplier;
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${assumedReason}` : assumedReason;
                            
                            const { error: updateErr } = await supabase.from('trade_logs').update({ exit_price: safeExitPrice, pnl: parseFloat(rawPnl.toFixed(4)), exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
                            
                            if (updateErr) {
                                console.error("[TRADE LOG UPDATE FAILED]:", updateErr.message);
                                await logAgentActivity(tenantId, "Watchdog", asset, `Failed to update trade log for ${openTrade.id}: ${updateErr.message}`, "ERROR");
                            } else {
                                await supabase.from('scan_results').insert([{ strategy: openTrade.strategy_id || 'MANUAL', asset: asset, status: 'CLOSED', telemetry: { macro_regime_oracle: `POSITION CLOSED`, oracle_reasoning: updatedReason, open_pnl: rawPnl.toFixed(4), open_position: "NONE" } }]);
                                await logAgentActivity(tenantId, "Watchdog", asset, `Position for ${asset} closed. PnL: ${rawPnl.toFixed(4)}. Trigger: ${assumedReason}.`, "POSITION_CLOSED");
                            }

const chartUrl = await buildWatchdogChart(asset, currentPrice, liveApiKey, liveApiSecret, openTrade);

                            const entryText = safeEntryPrice ? `\n**Entry Price:** $${safeEntryPrice}` : '';
                            const tpText = openTrade.tp_price ? `\n**Target TP:** $${openTrade.tp_price}` : '';
                            const slText = openTrade.sl_price ? `\n**Target SL:** $${openTrade.sl_price}` : '';

                            await sendDiscordAlert(tenantId, { 
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
                                    body: JSON.stringify({ tenant_id: tenantId, asset: asset, entry_price: safeEntryPrice, exit_price: safeExitPrice, pnl: rawPnl.toFixed(4), rolling_ledger: updatedReason, trigger: assumedReason })
                                });
                            } catch (autopsyErr) { console.error("[WATCHDOG AUTOPSY TRIGGER FAULT]:", autopsyErr.message); }

                            delete heartbeatTracker[openTrade.id]; 
                            if (missingBracketTracker[openTrade.id]) delete missingBracketTracker[openTrade.id];
                            continue; 
                        }
                    }

                    if (activePosition) {
                        const hasBracket = openOrders.some(o => o.client_order_id === ocoClientId || o.order_configuration?.trigger_bracket_gtc || o.client_order_id?.startsWith('nx_wd_oco_'));

                        // Clear the tracker if brackets are found
                        if (hasBracket && missingBracketTracker[openTrade.id]) {
                            delete missingBracketTracker[openTrade.id];
                        }

                        if (!hasBracket && openTrade.tp_price && openTrade.sl_price) {
                            
                            // 🟢 THE FIX: 10-Second Ceasefire Protocol
                            const now = Date.now();
                            if (!missingBracketTracker[openTrade.id]) {
                                missingBracketTracker[openTrade.id] = now;
                                await logAgentActivity(tenantId, "Watchdog", asset, `Missing OCO Brackets for ${asset} detected. Initiating 20s ceasefire.`, "MISSING_OCO_DETECTED");
                                console.log(`[WATCHDOG] Missing OCO Brackets detected for ${asset}. Yielding 20s for potential Hermes execution...`);
                                continue;
                            }
                            
                            // If it has been less than 20 seconds, do nothing and wait for the next sweep
                            if (now - missingBracketTracker[openTrade.id] < 20000) {
                                continue;
                            }

                            const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                            const orderQty = Math.abs(parseFloat(activePosition.number_of_contracts));
                            const safeSlPrice = (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(4);
                            const safeTpPrice = (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(4);

                            await logAgentActivity(tenantId, "Watchdog", asset, `Missing OCO Brackets for ${asset} exceeded grace period. Deploying deterministic safety net.`, "SAFETY_NET_DEPLOYMENT");
                            console.log(`[WATCHDOG] Missing OCO Brackets for ${asset} exceeded grace period. Deploying deterministic safety net...`);
                            const executePath = '/api/v3/brokerage/orders';
                            const dynamicSafetyNetId = `nx_wd_oco_${Date.now()}`;
                            const ocoPayload = {
                                client_order_id: dynamicSafetyNetId, product_id: coinbaseProduct, side: closingSide,
                                order_configuration: { trigger_bracket_gtc: { limit_price: safeTpPrice, stop_trigger_price: safeSlPrice, base_size: orderQty.toString() } }
                            };
                            
                            try {
                                const ocoResp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, liveApiKey, liveApiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                                
                                let ocoResult;
                                try {
                                    ocoResult = await ocoResp.json();
                                } catch (jsonErr) {
                                    console.error(`[WATCHDOG OCO FAULT] Exchange returned invalid data. Delaying bracket deployment...`);
                                    await logAgentActivity(tenantId, "Watchdog", asset, `OCO bracket deployment failed for ${asset}: Exchange returned invalid data.`, "ERROR");
                                    continue; 
                                }

                                if (!ocoResp.ok || ocoResult.success === false) {
                                    const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
                                    console.error(`[WATCHDOG BRACKET REJECT] OCO Failed:`, ocoErrMsg);
                                    await sendDiscordAlert(tenantId, { title: `⚠️ Watchdog Bracket Failed: ${asset}`, description: `**Action:** Attempted to deploy missing TP/SL protection!\n**Details:** ${ocoErrMsg}`, color: 15548997 });
                                    await logAgentActivity(tenantId, "Watchdog", asset, `OCO bracket deployment rejected for ${asset}: ${ocoErrMsg}`, "ERROR");
                                } else {
                                    // 📊 CHART: Safety Net deployed — send chart with deployed TP/SL
                                    const safetyNetChartUrl = await buildWatchdogChart(asset, currentPrice, liveApiKey, liveApiSecret, openTrade, safeTpPrice, safeSlPrice);
                                    await sendDiscordAlert(tenantId, { title: `🛡️ Watchdog Safety Net Deployed: ${asset}`, description: `**Take Profit:** $${safeTpPrice}\n**Stop Loss:** $${safeSlPrice}\n**Status:** OCO Brackets successfully attached to naked position.`, color: 10181046, imageUrl: safetyNetChartUrl });
                                    await logAgentActivity(tenantId, "Watchdog", asset, `OCO safety net deployed for ${asset}. TP: $${safeTpPrice}, SL: $${safeSlPrice}.`, "SAFETY_NET_SUCCESS");
                                    // Clean up tracker upon successful deployment
                                    delete missingBracketTracker[openTrade.id];
                                }
                            } catch (error) {
                                console.error("[WATCHDOG BRACKET FATAL]:", error.message);
                                await logAgentActivity(tenantId, "Watchdog", asset, `FATAL error during OCO bracket deployment for ${asset}: ${error.message}`, "ERROR");
                            }
                        }
                    }
                }

                // 🟢 PAPER TRADE TP/SL + TRIPWIRE + TRAILING SL LOGIC
                if (openTrade.execution_mode === 'PAPER') {
                    if (openTrade.tp_price && openTrade.sl_price) {
                        const rawPriceMove = openTrade.side === 'BUY' 
                            ? (currentPrice - openTrade.entry_price) / openTrade.entry_price 
                            : (openTrade.entry_price - currentPrice) / openTrade.entry_price;
                        const leverage = parseFloat(openTrade.leverage || 1);
                        const pnlPercent = rawPriceMove * leverage;

                        // 💚 PAPER HEARTBEAT: Log ROE every 60s
                        const now = Date.now();
                        if (!heartbeatTracker[openTrade.id] || now - heartbeatTracker[openTrade.id] >= 60000) {
                            await logAgentActivity(tenantId, "Watchdog", asset, `Heartbeat: Paper ROE: ${(pnlPercent * 100).toFixed(2)}%`, "HEARTBEAT");
                            console.log(`[WATCHDOG RADAR] Asset: ${asset} | Paper ROE: ${(pnlPercent * 100).toFixed(2)}%`);
                            heartbeatTracker[openTrade.id] = now;
                        }

                        // 🟢 PAPER TRIPWIRE: Fetch strategy config for tripwire/trailing params
                        const { data: paperConfigData } = await supabase.from('strategy_config').select('*').eq('tenant_id', tenantId).ilike('strategy', openTrade.strategy_id).eq('asset', asset).maybeSingle();
                        const paperParams = paperConfigData?.parameters || {};
                        const paperTripwire = parseFloat(paperParams.tripwire_percent || 0);
                        const paperTrailStep = parseFloat(paperParams.trail_step_percent || 0);
                        const paperTrailActivation = parseFloat(paperParams.trail_activation_percent || paperParams.tripwire_percent || 0);

                        // 🟢 PAPER TRIPWIRE: Move SL to break-even when profit target reached
                        if (paperTripwire > 0 && pnlPercent >= paperTripwire && !openTrade.reason?.includes('[TRIPWIRE_ACTIVATED]')) {
                            const breakEvenSL = openTrade.side === 'BUY' ? openTrade.entry_price * 1.001 : openTrade.entry_price * 0.999;
                            const safeBreakEvenSL = parseFloat((Math.round(breakEvenSL / tickSize) * tickSize).toFixed(4));
                            
                            const updatedReason = `${openTrade.reason || ''}\n\n[TRIPWIRE_ACTIVATED]: Profit reached ${(pnlPercent*100).toFixed(2)}%. SL moved to Break-Even (Paper).`;
                            await supabase.from('trade_logs').update({ sl_price: safeBreakEvenSL, reason: updatedReason }).eq('id', openTrade.id);
                            openTrade.sl_price = safeBreakEvenSL;
                            openTrade.reason = updatedReason;

                            await logAgentActivity(tenantId, "Watchdog", asset, `Paper tripwire hit! Profit at ${(pnlPercent*100).toFixed(2)}%. Moving SL to break-even.`, "TRIPWIRE_HIT");
                            console.log(`[WATCHDOG] Paper tripwire hit for ${asset} at ${(pnlPercent*100).toFixed(2)}% profit. SL moved to break-even.`);

                            await sendDiscordAlert(tenantId, {
                                title: `🛡️ Paper Tripwire Activated: ${asset}`,
                                description: `**Action:** SL moved to Break-Even at $${safeBreakEvenSL}\n**Profit at Trigger:** ${(pnlPercent*100).toFixed(2)}%`,
                                color: 10181046
                            });
                        }

                        // 🟢 PAPER TRAILING SL: Dynamically advance SL as profit increases
                        if (paperTrailStep > 0 && paperTrailActivation > 0 && pnlPercent >= paperTrailActivation) {
                            const assetTrailStep = paperTrailStep / leverage;
                            const dynamicSL = openTrade.side === 'BUY' ? currentPrice * (1 - assetTrailStep) : currentPrice * (1 + assetTrailStep);
                            const safeDynamicSL = parseFloat((Math.round(dynamicSL / tickSize) * tickSize).toFixed(4));
                            
                            let shouldMoveSL = false;
                            if (openTrade.side === 'BUY' && safeDynamicSL > openTrade.sl_price) shouldMoveSL = true;
                            if (openTrade.side === 'SELL' && safeDynamicSL < openTrade.sl_price && openTrade.sl_price !== 0) shouldMoveSL = true;
                            
                            const diff = Math.abs(safeDynamicSL - openTrade.sl_price);
                            if (shouldMoveSL && diff > (tickSize * 10)) {
                                await supabase.from('trade_logs').update({ sl_price: safeDynamicSL }).eq('id', openTrade.id);
                                openTrade.sl_price = safeDynamicSL;

                                await logAgentActivity(tenantId, "Watchdog", asset, `Paper trailing SL triggered. Moving SL to $${safeDynamicSL}.`, "TRAILING_SL_MOVE");
                                console.log(`[WATCHDOG] Paper trailing SL triggered for ${asset}. Moving SL up to $${safeDynamicSL}`);

                                await sendDiscordAlert(tenantId, {
                                    title: `🎯 Paper Trailing SL Updated: ${asset}`,
                                    description: `**New SL:** $${safeDynamicSL}\n**Direction:** ${openTrade.side === 'BUY' ? 'Up' : 'Down'}`,
                                    color: 10181046
                                });
                            }
                        }
                        
                        let triggerType = null;
                        let exactExitPrice = currentPrice;
                        
                        // Check TP trigger (BUY: price >= TP, SELL: price <= TP)
                        if (openTrade.side === 'BUY' && currentPrice >= openTrade.tp_price) {
                            triggerType = 'TAKE_PROFIT';
                            exactExitPrice = openTrade.tp_price;
                        } else if (openTrade.side === 'SELL' && currentPrice <= openTrade.tp_price) {
                            triggerType = 'TAKE_PROFIT';
                            exactExitPrice = openTrade.tp_price;
                        }
                        
                        // Check SL trigger (BUY: price <= SL, SELL: price >= SL)
                        if (!triggerType && openTrade.side === 'BUY' && currentPrice <= openTrade.sl_price) {
                            triggerType = 'STOP_LOSS';
                            exactExitPrice = openTrade.sl_price;
                        } else if (!triggerType && openTrade.side === 'SELL' && currentPrice >= openTrade.sl_price) {
                            triggerType = 'STOP_LOSS';
                            exactExitPrice = openTrade.sl_price;
                        }
                        
                        if (triggerType) {
                            const safeEntryPrice = parseFloat(openTrade.entry_price) || 0;
                            const safeExitPrice = parseFloat(exactExitPrice) || 0;
                            const safeQty = parseFloat(openTrade.qty) || 1;
                            const rawPnl = openTrade.side === 'BUY' 
                                ? (safeExitPrice - safeEntryPrice) * safeQty * multiplier 
                                : (safeEntryPrice - safeExitPrice) * safeQty * multiplier;
                            
                            const updatedReason = openTrade.reason 
                                ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${triggerType} (PAPER_TRADE_AUTOMATIC)` 
                                : `${triggerType} (PAPER_TRADE_AUTOMATIC)`;
                            
                            const { error: updateErr } = await supabase.from('trade_logs').update({ 
                                exit_price: safeExitPrice, 
                                pnl: parseFloat(rawPnl.toFixed(4)), 
                                exit_time: new Date().toISOString(), 
                                reason: updatedReason 
                            }).eq('id', openTrade.id);
                            
                            if (updateErr) {
                                console.error("[PAPER TRADE LOG UPDATE FAILED]:", updateErr.message);
                                await logAgentActivity(tenantId, "Watchdog", asset, `Failed to close paper trade ${openTrade.id}: ${updateErr.message}`, "ERROR");
                            } else {
                                await supabase.from('scan_results').insert([{ 
                                    strategy: openTrade.strategy_id || 'MANUAL', 
                                    asset: asset, 
                                    status: 'CLOSED', 
                                    telemetry: { 
                                        macro_regime_oracle: `POSITION CLOSED`, 
                                        oracle_reasoning: updatedReason, 
                                        open_pnl: rawPnl.toFixed(4), 
                                        open_position: "NONE" 
                                    } 
                                }]);
                                
                                await logAgentActivity(tenantId, "Watchdog", asset, `Paper trade for ${asset} closed. PnL: ${rawPnl.toFixed(4)}. Trigger: ${triggerType}.`, "POSITION_CLOSED");
                                
                                // 📊 CHART: Paper trade closed — build chart with TP/SL levels (public candle API, no auth needed)
                                const paperCloseChartUrl = await buildWatchdogChart(asset, currentPrice, null, null, openTrade);
                                
                                const entryText = safeEntryPrice ? `\n**Entry Price:** $${safeEntryPrice}` : '';
                                const tpText = openTrade.tp_price ? `\n**Target TP:** $${openTrade.tp_price}` : '';
                                const slText = openTrade.sl_price ? `\n**Target SL:** $${openTrade.sl_price}` : '';
                                
                                await sendDiscordAlert(tenantId, { 
                                    title: `📊 Paper Trade Closed: ${asset}`, 
                                    description: `**Trigger:** ${triggerType}\n**Realized PnL:** $${rawPnl.toFixed(4)}${entryText}${tpText}${slText}\n**Exit Price:** $${safeExitPrice}`, 
                                    color: rawPnl >= 0 ? 5763719 : 15548997,
                                    imageUrl: paperCloseChartUrl
                                });
                            }
                        }
                    } else {
                        // No TP/SL configured for paper trade - just monitor
                        await logAgentActivity(tenantId, "Watchdog", asset, `Paper trade ${openTrade.id} has no TP/SL configured. Current price: $${currentPrice}.`, "INFO");
                    }
                }
            } // end for
        } catch (err) {
            console.error("[WATCHDOG FAULT]:", err.message);
            await logAgentActivity(tenantId, "Watchdog", "N/A", `WATCHDOG worker encountered a fault: ${err.message}`, "ERROR");
        }
    }, 5000);
} // end startWatchdog

async function logAgentActivity(tenant_id, agent_name, asset, log_message, log_type = 'INFO') {
    try {
        const { error } = await supabase.from('agent_session_logs').insert([
            { tenant_id, agent_name, asset, log_message, log_type, timestamp: new Date().toISOString() }
        ]);
        if (error) {
            console.error("[WATCHDOG LOGGING ERROR]: Failed to log agent activity:", error.message);
        }
    } catch (err) {
        console.error("[WATCHDOG LOGGING FATAL]: Uncaught error in logAgentActivity:", err.message);
    }
}