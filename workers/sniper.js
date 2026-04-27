// workers/sniper.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
        const response = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
        if (!response.ok) console.error(`[DISCORD REJECTION] Status ${response.status}:`, await response.text());
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

// ... (Keep your exact getAssetMetrics, fetchCoinbaseData, and fetchMicrostructure functions here) ...

// 🟢 THE NEW CONTINUOUS SNIPER LOOP
export async function startSniper() {
    console.log(`[SNIPER] Target acquisition system online. Sweeping continuous tape...`);
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    // Run this loop infinitely every 10 seconds
    setInterval(async () => {
        try {
            const { data: activeConfigs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
            if (!activeConfigs || activeConfigs.length === 0) return;

            for (const config of activeConfigs) {
                const asset = config.asset;
                if (!asset || config.is_processing) continue;

                // Lock the row so the Watchdog doesn't clash with it
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

                    if (!macroCandles || !triggerCandles || macroCandles.length < 21) continue;
                    const currentPrice = triggerCandles[triggerCandles.length - 1].close;

                    const microstructure = await fetchMicrostructure(asset, triggerCandles, macroCandles, apiKeyName, apiSecret);

                    // We only fetch the open trade to know if a signal is a REVERSAL
                    const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', asset).eq('strategy_id', config.strategy).is('exit_price', null).order('id', { ascending: false }).limit(1);
                    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

                    // 1. TRAP EVALUATION
                    if (config.trap_side && config.trap_price && config.trap_expires_at) {
                        const expiresAt = new Date(config.trap_expires_at).getTime();
                        if (Date.now() > expiresAt) trapExpired = true;
                        else if (config.trap_side === 'BUY' && currentPrice <= config.trap_price) trapSprung = true;
                        else if (config.trap_side === 'SELL' && currentPrice >= config.trap_price) trapSprung = true;
                    }

                    if (trapSprung) {
                        console.log(`[SNIPER] Ghost Trap sprung for ${asset}!`);
                        // Build execution payload and trigger local execution tool
                        config.clear_trap = true;
                        continue;
                    }

                    // 2. STRATEGY EVALUATION
                    const marketData = { macro: macroCandles, trigger: triggerCandles };
                    let decision = await evaluateStrategy(config.strategy, marketData, config.parameters);
                    if (decision.error) continue;

                    decision.telemetry = {
                        ...decision.telemetry,
                        macro_poc: microstructure.indicators.macro_poc,
                        upper_macro_node: microstructure.indicators.upper_macro_node,
                        lower_macro_node: microstructure.indicators.lower_macro_node,
                        micro_cvd: microstructure.indicators.current_cvd
                    };

                    if (decision.signal) {
                        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
                        
                        // 3. ORACLE EVALUATION
                        const oracleVerdict = await evaluateTradeIdea({
                            mode: (openTrade && openTrade.side !== normalizedSignal) ? 'REVERSAL' : 'ENTRY',
                            asset, strategy: config.strategy, signal: normalizedSignal,
                            currentPrice, candles: triggerCandles, macroCandles: macroCandles,
                            indicators: microstructure.indicators, orderBook: microstructure.orderBook,
                            derivativesData: microstructure.derivativesData, openTrade, activeThesis: config.active_thesis
                        });

                        config.new_thesis = oracleVerdict.working_thesis;

                        if (oracleVerdict.action === 'VETO') {
                            await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('strategy', config.strategy);
                            const chartUrl = await buildRadarChartUrl({ asset, candles: triggerCandles, currentPrice, poc: microstructure.indicators.macro_poc, upperNode: microstructure.indicators.upper_macro_node, lowerNode: microstructure.indicators.lower_macro_node, trapPrice: config.new_trap_price, trapSide: config.new_trap_side });
                            
                            await sendDiscordAlert({ title: `👻 Oracle Veto: ${asset}`, description: `**Signal:** ${normalizedSignal} (Rejected)\n\n**🧠 Oracle Rationale:**\n_${oracleVerdict.reasoning}_`, color: 10038562, imageUrl: chartUrl });
                        } else {
                            // Trigger Local MCP Execution Vault
                            console.log(`[SNIPER] Firing execution sequence for ${asset}...`);
                        }
                    }

                } catch (assetErr) {
                    console.error(`[ASSET ERROR] ${asset}:`, assetErr.message);
                } finally {
                    const finalUpdates = { is_processing: false };
                    if (config.new_thesis) finalUpdates.active_thesis = config.new_thesis;
                    if (config.clear_trap || trapExpired) {
                        finalUpdates.trap_side = null; finalUpdates.trap_price = null; finalUpdates.trap_expires_at = null;
                    }
                    await supabase.from('strategy_config').update(finalUpdates).eq('strategy', config.strategy);
                }
            }
        } catch (err) {
            console.error("[SNIPER FAULT]:", err.message);
        }
    }, 10000); 
}