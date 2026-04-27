// workers/sniper.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import WebSocket from 'ws'; // 🟢 THE NEW SPINAL CORD
import { evaluateStrategy } from '../lib/strategy-router.js';
import { evaluateTradeIdea } from '../lib/trade-oracle.js';
import { buildRadarChartUrl } from '../lib/discord-chart.js';

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

// ... [Keep your fetchCoinbaseData and fetchMicrostructure functions exactly as they were here] ...
async function fetchCoinbaseData(asset, granularity, apiKey, secret) { /* ... */ }
async function fetchMicrostructure(asset, triggerCandles, macroCandles, apiKey, secret) { /* ... */ }


// 🟢 THE NEW WEBSOCKET STATE MANAGER
const RAM = {
    configs: [],           // Holds active strategies in memory
    lastMathRun: {},       // Throttles the heavy math to 60 seconds
    isProcessingMath: {}   // Prevents overlapping API calls
};

export async function startSniper() {
    console.log(`[SNIPER] Booting WebSocket Spinal Cord...`);
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    // 1. Sync RAM with Supabase every 30 seconds (Picks up Hermes policy changes)
    const syncConfigs = async () => {
        try {
            const { data } = await supabase.from('strategy_config').select('*').eq('is_active', true);
            if (data) RAM.configs = data;
        } catch (e) { console.error("[RAM SYNC FAULT]", e.message); }
    };
    await syncConfigs();
    setInterval(syncConfigs, 30000); 

    // 2. Connect to Coinbase Advanced Trade WebSockets
    const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    ws.on('open', () => {
        console.log(`[SNIPER] WebSocket connected. Subscribing to live tape...`);
        // Extract unique product IDs for the subscription
        const productIds = [...new Set(RAM.configs.map(c => {
            let p = c.asset.toUpperCase().trim();
            if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
            return p;
        }))];

        if (productIds.length > 0) {
            ws.send(JSON.stringify({
                type: 'subscribe',
                product_ids: productIds,
                channel: 'ticker' // Public live price channel (no JWT required)
            }));
        }
    });

    // 3. The Live Event Listener (Fires multiple times per second)
    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        if (message.channel !== 'ticker' || !message.events) return;

        const tick = message.events[0].tickers[0];
        if (!tick) return;

        const currentPrice = parseFloat(tick.price);
        const wsAsset = tick.product_id;

        // Find all active configs tracking this specific asset
        const activeAssetConfigs = RAM.configs.filter(c => {
            let p = c.asset.toUpperCase().trim();
            if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
            return p === wsAsset;
        });

        for (const config of activeAssetConfigs) {
            const params = config.parameters || {};

            // 🟢 MILLISECOND TRAP EXECUTION (Bypasses all throttles)
            if (config.trap_side && config.trap_price && config.trap_expires_at) {
                const expiresAt = new Date(config.trap_expires_at).getTime();
                let trapSprung = false;

                if (Date.now() > expiresAt) {
                    config.trap_side = null; // Expired in RAM
                    await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_expires_at: null }).eq('id', config.id);
                } else if (config.trap_side === 'BUY' && currentPrice <= config.trap_price) {
                    trapSprung = true;
                } else if (config.trap_side === 'SELL' && currentPrice >= config.trap_price) {
                    trapSprung = true;
                }

                if (trapSprung) {
                    console.log(`[SNIPER] LIGHTNING TRAP SPRUNG for ${config.asset} at $${currentPrice}!`);
                    
                    config.trap_side = null; // Instantly clear from RAM to prevent double-firing
                    await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_expires_at: null }).eq('id', config.id);

                    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
                    let finalQty = params.qty || 1;
                    if (params.target_usd) {
                        const { multiplier } = getAssetMetrics(config.asset);
                        finalQty = Math.max(1, Math.round(params.target_usd / (currentPrice * multiplier)));
                    }

                    const slP = params.sl_percent || 0.01; const tpP = params.tp_percent || 0.02;
                    const trapTpPrice = config.trap_side === 'BUY' ? currentPrice * (1 + tpP) : currentPrice * (1 - tpP);
                    const trapSlPrice = config.trap_side === 'BUY' ? currentPrice * (1 - slP) : currentPrice * (1 + slP);
                    const { tickSize } = getAssetMetrics(config.asset);

                    const trapPayload = {
                        symbol: config.asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: config.trap_side,
                        order_type: 'MARKET', price: currentPrice, 
                        tp_price: parseFloat((Math.round(trapTpPrice / tickSize) * tickSize).toFixed(4)), 
                        sl_price: parseFloat((Math.round(trapSlPrice / tickSize) * tickSize).toFixed(4)),
                        execution_mode: config.execution_mode || 'PAPER', leverage: params.leverage || 1,
                        market_type: params.market_type || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)),
                        reason: `[VIRTUAL TRAP SPRUNG]: Lightning WS Execution at $${currentPrice}`
                    };
                    
                    fetch(`${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trapPayload) }).catch(e => console.error("Trap Execution Error:", e));
                    continue; 
                }
            }

            // 🟢 THROTTLED STRATEGY MATH (Runs every 60 seconds max per strategy)
            const now = Date.now();
            const lastRun = RAM.lastMathRun[config.strategy] || 0;
            const isProcessing = RAM.isProcessingMath[config.strategy] || false;

            if (isProcessing || (now - lastRun < 60000)) continue; 

            // Lock it locally and in DB
            RAM.isProcessingMath[config.strategy] = true;
            RAM.lastMathRun[config.strategy] = now;
            await supabase.from('strategy_config').update({ is_processing: true }).eq('id', config.id);

            try {
                const cooldownMins = params.veto_cooldown_minutes || 15;
                const lastVeto = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
                if ((Date.now() - lastVeto) < (cooldownMins * 60000)) continue;

                const macroTf = params.macro_tf || 'ONE_HOUR';
                const triggerTf = params.trigger_tf || 'FIVE_MINUTE';

                const [macroCandles, triggerCandles] = await Promise.all([
                    fetchCoinbaseData(config.asset, macroTf, apiKeyName, apiSecret),
                    fetchCoinbaseData(config.asset, triggerTf, apiKeyName, apiSecret)
                ]);

                if (!macroCandles || !triggerCandles) continue;

                const microstructure = await fetchMicrostructure(config.asset, triggerCandles, macroCandles, apiKeyName, apiSecret);
                const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', config.asset).eq('strategy_id', config.strategy).is('exit_price', null).limit(1);
                const openTrade = openTrades?.[0];

                let decision = await evaluateStrategy(config.strategy, { macro: macroCandles, trigger: triggerCandles }, params);

                decision.telemetry = { 
                    ...decision.telemetry, 
                    macro_poc: microstructure.indicators.macro_poc,
                    upper_macro_node: microstructure.indicators.upper_macro_node,
                    lower_macro_node: microstructure.indicators.lower_macro_node,
                    macro_cvd: microstructure.indicators.macro_cvd,
                    micro_cvd: microstructure.indicators.current_cvd,
                    bids: microstructure.orderBook.bids_50_levels || 0,
                    asks: microstructure.orderBook.asks_50_levels || 0,
                    premium: microstructure.derivativesData.basis_premium_percent || 0,
                    macro_regime_oracle: "EVALUATING",
                    oracle_reasoning: "Awaiting signal..."
                };

                if (decision.signal) {
                    const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
                    
                    const oracleVerdict = await evaluateTradeIdea({
                        mode: (openTrade && openTrade.side !== normalizedSignal) ? 'REVERSAL' : 'ENTRY',
                        asset: config.asset, strategy: config.strategy, signal: normalizedSignal,
                        currentPrice, candles: triggerCandles, macroCandles: macroCandles,
                        indicators: microstructure.indicators, orderBook: microstructure.orderBook,
                        derivativesData: microstructure.derivativesData, openTrade, 
                        dynamicSizing: params.dynamic_sizing, activeThesis: config.active_thesis
                    });

                    config.new_thesis = oracleVerdict.working_thesis;
                    decision.telemetry.oracle_reasoning = oracleVerdict.reasoning;
                    decision.telemetry.oracle_score = oracleVerdict.conviction_score;
                    decision.telemetry.macro_regime_oracle = oracleVerdict.market_regime || "EVALUATING";

                    if (oracleVerdict.trap_side && oracleVerdict.trap_price && oracleVerdict.trap_expires_in_minutes) {
                        const expireTime = new Date(Date.now() + (oracleVerdict.trap_expires_in_minutes * 60000)).toISOString();
                        config.trap_side = oracleVerdict.trap_side; config.trap_price = oracleVerdict.trap_price; config.trap_expires_at = expireTime;
                        await supabase.from('strategy_config').update({ trap_side: config.trap_side, trap_price: config.trap_price, trap_expires_at: expireTime }).eq('id', config.id);
                    } 

                    if (oracleVerdict.action === 'VETO') {
                        decision.statusOverride = 'ORACLE VETO';
                        await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('id', config.id);
                        
                        const chartUrl = await buildRadarChartUrl({ asset: config.asset, candles: triggerCandles, currentPrice, poc: microstructure.indicators.macro_poc, upperNode: microstructure.indicators.upper_macro_node, lowerNode: microstructure.indicators.lower_macro_node, trapPrice: config.trap_price, trapSide: config.trap_side });
                        await sendDiscordAlert({ title: `👻 Veto: ${config.asset}`, description: `_${oracleVerdict.reasoning}_`, color: 10038562, imageUrl: chartUrl });
                    } else {
                        decision.statusOverride = 'RESONANT';
                        
                        const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
                        let finalQty = params.qty || 1;
                        if (params.target_usd) {
                            const { multiplier } = getAssetMetrics(config.asset);
                            finalQty = Math.max(1, Math.round(params.target_usd / (oracleVerdict.limit_price || currentPrice) * multiplier));
                        }

                        const tradePayload = {
                            symbol: config.asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: normalizedSignal,
                            order_type: oracleVerdict.order_type || 'MARKET', price: oracleVerdict.limit_price || currentPrice, 
                            tp_price: oracleVerdict.tp_price || null, sl_price: oracleVerdict.sl_price || null,
                            execution_mode: config.execution_mode || 'PAPER', leverage: params.leverage || 1,
                            market_type: params.market_type || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)), reason: oracleVerdict.reasoning 
                        };
                        fetch(`${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tradePayload) }).catch(e => console.error(e));
                    }
                }

                // UI Sonar Heartbeat
                const finalStatus = decision.statusOverride || (decision.signal ? "RESONANT" : "STABLE");
                await supabase.from('scan_results').insert([{ strategy: config.strategy, asset: config.asset, telemetry: decision.telemetry, status: finalStatus }]);

            } catch (e) { console.error(`[ASSET ERROR] ${config.asset}:`, e.message); }
            finally {
                RAM.isProcessingMath[config.strategy] = false;
                await supabase.from('strategy_config').update({ is_processing: false, active_thesis: config.new_thesis || config.active_thesis }).eq('id', config.id);
            }
        }
    });

    ws.on('close', () => {
        console.error('[SNIPER] WebSocket disconnected. Attempting to reconnect in 5 seconds...');
        setTimeout(startSniper, 5000);
    });

    ws.on('error', (err) => { console.error('[SNIPER] WebSocket Error:', err.message); });
}