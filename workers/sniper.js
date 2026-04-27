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

// ... (fetchCoinbaseData, fetchMicrostructure, getAssetMetrics here) ...

export async function startSniper() {
    console.log(`[SNIPER] Systems fully integrated. Watching parameters...`);
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    setInterval(async () => {
        try {
            const { data: activeConfigs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
            if (!activeConfigs) return;

            for (const config of activeConfigs) {
                const asset = config.asset;
                const params = config.parameters || {};

                // 🟢 1. COOLDOWN GUARDRAIL
                const cooldownMins = params.veto_cooldown_minutes || 15;
                const lastVeto = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
                if ((Date.now() - lastVeto) < (cooldownMins * 60000)) continue;

                if (config.is_processing) continue;
                await supabase.from('strategy_config').update({ is_processing: true }).eq('strategy', config.strategy);

                try {
                    // 🟢 2. TIME-FRAME INJECTION
                    const macroTf = params.macro_tf || 'ONE_HOUR';
                    const triggerTf = params.trigger_tf || 'FIVE_MINUTE';

                    const [macroCandles, triggerCandles] = await Promise.all([
                        fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
                        fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
                    ]);

                    if (!macroCandles || !triggerCandles) continue;
                    const currentPrice = triggerCandles[triggerCandles.length - 1].close;

                    // 🟢 3. X-RAY HANDOFF (Microstructure)
                    const microstructure = await fetchMicrostructure(asset, triggerCandles, macroCandles, apiKeyName, apiSecret);

                    const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', asset).eq('strategy_id', config.strategy).is('exit_price', null).limit(1);
                    const openTrade = openTrades?.[0];

                    // 🟢 4. THE STRATEGY ROUTER (Local Math)
                    let decision = await evaluateStrategy(config.strategy, { macro: macroCandles, trigger: triggerCandles }, params);

                    decision.telemetry = { 
                        ...decision.telemetry, 
                        macro_poc: microstructure.indicators.macro_poc,
                        micro_cvd: microstructure.indicators.current_cvd,
                        oracle_reasoning: "Awaiting signal..."
                    };

                    // 🟢 5. GEMINI HANDOFF (Only if math fires)
                    if (decision.signal) {
                        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
                        
                        const oracleVerdict = await evaluateTradeIdea({
                            mode: (openTrade && openTrade.side !== normalizedSignal) ? 'REVERSAL' : 'ENTRY',
                            asset, strategy: config.strategy, signal: normalizedSignal,
                            currentPrice, candles: triggerCandles, macroCandles: macroCandles,
                            indicators: microstructure.indicators, orderBook: microstructure.orderBook,
                            derivativesData: microstructure.derivativesData, openTrade, 
                            dynamicSizing: params.dynamic_sizing, activeThesis: config.active_thesis
                        });

                        config.new_thesis = oracleVerdict.working_thesis;
                        decision.telemetry.oracle_reasoning = oracleVerdict.reasoning;
                        decision.telemetry.oracle_score = oracleVerdict.conviction_score;

                        if (oracleVerdict.action === 'VETO') {
                            decision.statusOverride = 'ORACLE VETO';
                            await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('strategy', config.strategy);
                            
                            const chartUrl = await buildRadarChartUrl({ asset, candles: triggerCandles, currentPrice, poc: microstructure.indicators.macro_poc });
                            await sendDiscordAlert({ title: `👻 Veto: ${asset}`, description: `_${oracleVerdict.reasoning}_`, color: 10038562, imageUrl: chartUrl });
                        } else {
                            decision.statusOverride = 'RESONANT';
                            
                            // 🟢 6. THE HANDS (Physical Execution)
                            const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
                            const tradePayload = {
                                symbol: asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: normalizedSignal,
                                order_type: oracleVerdict.order_type || 'MARKET', 
                                price: oracleVerdict.limit_price || currentPrice, 
                                tp_price: oracleVerdict.tp_price || null, sl_price: oracleVerdict.sl_price || null,
                                execution_mode: config.execution_mode || 'PAPER', leverage: params.leverage || 1,
                                market_type: params.market_type || 'FUTURES', qty: params.qty || 1,
                                reason: oracleVerdict.reasoning 
                            };
                            await fetch(`${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tradePayload) });
                        }
                    }

                    // 🟢 7. SONAR HEARTBEAT (UI Update)
                    const finalStatus = decision.statusOverride || (decision.signal ? "RESONANT" : "STABLE");
                    await supabase.from('scan_results').insert([{ strategy: config.strategy, asset, telemetry: decision.telemetry, status: finalStatus }]);

                } catch (e) { console.error(`[ASSET ERROR] ${asset}:`, e.message); }
                finally {
                    await supabase.from('strategy_config').update({ is_processing: false, active_thesis: config.new_thesis || config.active_thesis }).eq('strategy', config.strategy);
                }
            }
        } catch (err) { console.error("[SNIPER FAULT]:", err.message); }
    }, 10000);
}