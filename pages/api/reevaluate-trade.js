// pages/api/reevaluate-trade.js
export const maxDuration = 300;

import { createClient } from '@supabase/supabase-js';
import { executeTradeMCP } from '../../lib/execute-trade-mcp.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateTradeIdea } from '../../lib/trade-oracle.js';
import { buildRadarChartUrl } from '../../lib/discord-chart.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- 📱 DISCORD MESSENGER ---
async function sendDiscordAlert(title, description, color, imageUrl = null) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        const embed = { title, description, color, timestamp: new Date().toISOString() };
        if (imageUrl) embed.image = { url: imageUrl };
        await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

function generateCoinbaseToken(method, path, apiKey, apiSecret) {
    const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
    const uriPath = path.split('?')[0]; 
    return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
    );
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { trade_id } = req.body;
        if (!trade_id) throw new Error("Missing trade_id");

        const apiKeyName = process.env.COINBASE_API_KEY;
        const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

        // 1. Get the Trade
        const { data: trades, error: tradeErr } = await supabase.from('trade_logs').select('*').eq('id', trade_id).limit(1);
        if (tradeErr || !trades || trades.length === 0) throw new Error("Trade not found");
        const trade = trades[0];

        if (trade.exit_price) return res.status(400).json({ error: "Trade is already closed." });

        // 2. Get Strategy Config for Timeframes & MUTEX LOCK
        const { data: configs } = await supabase.from('strategy_config').select('*').eq('strategy', trade.strategy_id).limit(1);
        const config = configs?.[0] || {};

        // --- 🛡️ DEFENSE: MUTEX LOCK CHECK FOR MANUAL REVIEWS ---
        if (config.is_processing) {
            return res.status(429).json({ error: "The automated background Watchdog is currently scanning this asset. Please wait 5 seconds and try again to prevent conflicts." });
        }

        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        // 3. Fetch Data
        const [macroCandles, triggerCandles] = await Promise.all([
            fetchCoinbaseData(trade.symbol, macroTf, apiKeyName, apiSecret),
            fetchCoinbaseData(trade.symbol, triggerTf, apiKeyName, apiSecret)
        ]);
        
        if (!macroCandles || !triggerCandles) throw new Error("Failed to fetch market data from Coinbase");
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;
        const pnlPercent = trade.side === 'BUY' ? (currentPrice - trade.entry_price) / trade.entry_price : (trade.entry_price - currentPrice) / trade.entry_price;

        const microstructure = await fetchMicrostructure(triggerCandles);

        // 🪙 TOKEN OPTIMISATION: we used to ship the FULL trade object to the
        // oracle on every manual review — including trade.reason, which the app
        // appends a new [MANUAL REVIEW ...] block to on every prior re-eval.
        // After a few reviews that field is multi-KB of redundant history that
        // bloats every Gemini call. The model only needs the LAST thesis to
        // continue reasoning, so we pull it from strategy_config.active_thesis
        // (the source of truth written by execute-trade-mcp.js), fall back to
        // the most recent [MANUAL REVIEW ...] block, and ship a sanitised
        // trade object with `reason` collapsed to just that latest snippet.
        let lastThesis = '';
        try {
            const { data: cfg } = await supabase
                .from('strategy_config')
                .select('active_thesis')
                .eq('tenant_id', trade.tenant_id)
                .eq('strategy', trade.strategy_id)
                .eq('asset', trade.symbol)
                .maybeSingle();
            lastThesis = cfg?.active_thesis || '';
        } catch (_) { /* non-fatal */ }
        if (!lastThesis && typeof trade.reason === 'string' && trade.reason.includes('[MANUAL REVIEW')) {
            // last "[MANUAL REVIEW - HH:MM:SS]: ..." chunk
            lastThesis = trade.reason.split('[MANUAL REVIEW').pop().split(']:').slice(1).join(']:').trim();
        }
        if (!lastThesis && typeof trade.reason === 'string') {
            lastThesis = trade.reason.slice(-600);   // hard cap fallback so we never balloon
        }
        const sanitizedTrade = { ...trade, reason: lastThesis };

        // 4. CALL THE ORACLE IN SNIPER MODE
        const verdict = await evaluateTradeIdea({
            mode: 'MANUAL_REVIEW', asset: trade.symbol, strategy: trade.strategy_id, currentPrice,
            candles: triggerCandles, macroCandles, indicators: microstructure.indicators,
            pnlPercent, openTrade: sanitizedTrade, activeThesis: lastThesis
        });

        let coinbaseProduct = trade.symbol.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) {
            if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
            else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
            else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
        }

        const appendReason = (msg) => `${trade.reason || ''}\n\n[MANUAL REVIEW - ${new Date().toISOString().split('T')[1].split('.')[0]}]: ${msg}`;

        // 5. EXECUTE THE VERDICT
        if (verdict.action === 'HOLD') {
            // 🟢 THE FIX: Catching Supabase update errors
            const { error: dbErr } = await supabase.from('trade_logs').update({ reason: appendReason(verdict.reasoning) }).eq('id', trade.id);
            if (dbErr) throw new Error(`Database failed to save HOLD status: ${dbErr.message}`);
            
            // 📱 ALERT: HOLD
            await sendDiscordAlert(`🛡️ Sniper Review: HOLD ${trade.symbol}`, `**Action:** Maintaining current position.\n**Oracle:** ${verdict.reasoning}`, 10181046); 
            return res.status(200).json({ status: "HOLD", reasoning: verdict.reasoning });
        } 
        
        else if (verdict.action === 'MARKET_CLOSE') {
            // 🟢 THE FIX: Full payload injected to satisfy execute-trade route validation
            const payload = {
                symbol: trade.symbol, 
                strategy_id: trade.strategy_id, 
                version: trade.version || 'v1.0',
                side: trade.side === 'BUY' ? 'SELL' : 'BUY',
                order_type: 'MARKET', 
                price: currentPrice,
                qty: trade.qty, 
                execution_mode: trade.execution_mode || 'PAPER',
                leverage: trade.leverage || 1,
                market_type: trade.market_type || 'FUTURES',
                reason: `[ORACLE MANUAL REVIEW CLOSE]: ${verdict.reasoning}`,
                tenant_id: trade.tenant_id
            };
            
            console.log(`[REEVALUATE] Direct execution for ${trade.symbol} close (Tenant: ${trade.tenant_id})`);
            const engineResult = await executeTradeMCP(payload);
            
            // 📱 ALERT: FORCE CLOSE
            await sendDiscordAlert(`🎯 Sniper Review: CLOSE ${trade.symbol}`, `**Action:** Force closing position.\n**Oracle:** ${verdict.reasoning}`, 15548997);
            return res.status(200).json({ status: "CLOSED", reasoning: verdict.reasoning });
        } 
        
        else if (verdict.action === 'ADJUST_LIMITS') {
            const oldTp = trade.tp_price || 'None';
            const oldSl = trade.sl_price || 'None';
            
            let safeTp = null;
            let safeSl = null;

            // 🛡️ ACCOUNTANT PROTOCOL: Enforce hard R/R >= 1.5 floor before any bracket adjustment
            const proposedTp = verdict.tp_price;
            const proposedSl = verdict.sl_price;
            if (proposedTp && proposedSl && trade.entry_price) {
                const entryPrice = parseFloat(trade.entry_price);
                const tpDist = Math.abs(proposedTp - entryPrice);
                const slDist = Math.abs(entryPrice - proposedSl);
                const riskReward = slDist > 0 ? (tpDist / slDist) : 0;
                if (riskReward < 1.5) {
                    console.warn(`[ACCOUNTANT PROTOCOL] Reevaluate ADJUST_LIMITS REJECTED for ${trade.symbol}. R/R ${riskReward.toFixed(2)} < 1.5. TP: $${proposedTp}, SL: $${proposedSl}, Entry: $${entryPrice}`);
                    await sendDiscordAlert(`🚫 Accountant Veto: ${trade.symbol}`, `**Action:** ADJUST_LIMITS blocked\n**New R/R:** ${riskReward.toFixed(2)} (minimum 1.5)\n**Proposed TP:** $${proposedTp}\n**Proposed SL:** $${proposedSl}\n**Entry:** $${entryPrice}\n**Oracle:** ${verdict.reasoning}`, 15548997);
                    return res.status(200).json({ status: "RR_VETOED", reasoning: `R/R ${riskReward.toFixed(2)} < 1.5 floor` });
                }
                console.log(`[ACCOUNTANT PROTOCOL] Reevaluate ADJUST_LIMITS R/R check passed: ${riskReward.toFixed(2)} >= 1.5`);
            }

            if (trade.execution_mode === 'LIVE') {
                // 🛡️ PHASE G: Delegate ADJUST_LIMITS to the hardened executeTradeMCP path.
                // That path already handles: cfm/positions reconcile, bracket cancel,
                // new bracket POST with exchange-truth qty, accountant R/R floor,
                // and Discord alerts on rejection. Single source of truth for close-side logic.
                const delegatePayload = {
                    symbol: trade.symbol,
                    strategy_id: trade.strategy_id || 'MANUAL',
                    version: trade.version || 'v1.0',
                    side: trade.side, // executeTradeMCP looks up openTrade by trade_id; side here is informational
                    trade_id: trade.id,
                    tp_price: verdict.tp_price,
                    sl_price: verdict.sl_price,
                    qty: trade.qty,
                    execution_mode: 'LIVE',
                    market_type: trade.market_type || 'FUTURES',
                    leverage: trade.leverage || 1,
                    reason: '[ADJUST_TP_SL] Sniper manual review bracket update',
                    tenant_id: trade.tenant_id
                };
                const delegateResult = await executeTradeMCP(delegatePayload);
                if (delegateResult?.status === 'rr_vetoed') {
                    await sendDiscordAlert(`🚫 Sniper R/R Veto: ${trade.symbol}`, `**Reason:** ${delegateResult.reason || 'R/R floor'}`, 15548997);
                    return res.status(200).json({ status: 'RR_VETOED', reasoning: delegateResult.reason });
                }
                if (delegateResult?.error) {
                    await sendDiscordAlert(`⚠️ Sniper Bracket Failed: ${trade.symbol}`, `**Action:** Failed to update TP/SL via execute engine.\n**Details:** ${delegateResult.error}`, 15548997);
                }
                safeTp = verdict.tp_price;
                safeSl = verdict.sl_price;
            } else {
                safeTp = verdict.tp_price;
                safeSl = verdict.sl_price;
            }
            
            // 🟢 THE FIX: Checking for DB rejection on Bracket updates
            const { error: limitDbErr } = await supabase.from('trade_logs').update({ 
                tp_price: safeTp || verdict.tp_price, sl_price: safeSl || verdict.sl_price, 
                reason: appendReason(`ADJUSTED LIMITS. ${verdict.reasoning}`) 
            }).eq('id', trade.id);

            if (limitDbErr) throw new Error(`Database failed to save updated limits: ${limitDbErr.message}`);

            // 📊 CHART: Build chart with new TP/SL levels
            const adjustChartUrl = await buildRadarChartUrl({
                asset: trade.symbol,
                candles: triggerCandles.slice(-50),
                currentPrice,
                tpPrice: safeTp || verdict.tp_price,
                slPrice: safeSl || verdict.sl_price,
                openTrade: trade
            });

            // 📱 ALERT: ADJUST LIMITS WITH OLD VS NEW
            await sendDiscordAlert(`🛠️ Sniper Review: ADJUSTED ${trade.symbol}`, `**Old Brackets:** TP $${oldTp} | SL $${oldSl}\n**New Brackets:** TP $${safeTp || 'N/A'} | SL $${safeSl || 'N/A'}\n**Oracle:** ${verdict.reasoning}`, 3447003, adjustChartUrl);

            return res.status(200).json({ status: "ADJUSTED", reasoning: verdict.reasoning });
        } else {
            // 🟢 THE FIX: Trap door for rogue AI outputs
            throw new Error(`Oracle returned an unrecognized action: ${verdict.action}`);
        }

    } catch (err) {
        console.error("[SNIPER FAULT]:", err.message);
        // 📱 ALERT: SNIPER FAULT
        await sendDiscordAlert("❌ Sniper Review Fault", `**Error:** ${err.message}`, 15548997);
        return res.status(500).json({ error: err.message });
    }
}

// Data Helpers
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
        return data.candles?.map(c => ({ close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();
    } catch (err) { throw err; }
}

async function fetchMicrostructure(triggerCandles) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = [];
        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i], prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;
        return { indicators: { current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2) } };
    } catch (e) { return { indicators: {} }; }
}