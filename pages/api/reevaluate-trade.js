// pages/api/reevaluate-trade.js
export const maxDuration = 300;

import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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

        // 4. CALL THE ORACLE IN SNIPER MODE
        const verdict = await evaluateTradeIdea({
            mode: 'MANUAL_REVIEW', asset: trade.symbol, strategy: trade.strategy_id, currentPrice, 
            candles: triggerCandles, macroCandles, indicators: microstructure.indicators, 
            pnlPercent, openTrade: trade
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
            await supabase.from('trade_logs').update({ reason: appendReason(verdict.reasoning) }).eq('id', trade.id);
            
            // 📱 ALERT: HOLD
            await sendDiscordAlert(`🛡️ Sniper Review: HOLD ${trade.symbol}`, `**Action:** Maintaining current position.\n**Oracle:** ${verdict.reasoning}`, 10181046); 
            return res.status(200).json({ status: "HOLD", reasoning: verdict.reasoning });
        } 
        
        else if (verdict.action === 'MARKET_CLOSE') {
            const payload = {
                symbol: trade.symbol, strategy_id: trade.strategy_id, side: trade.side === 'BUY' ? 'SELL' : 'BUY',
                order_type: 'MARKET', qty: trade.qty, reason: `[ORACLE MANUAL REVIEW CLOSE]: ${verdict.reasoning}`
            };
            const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
            const protocol = host.includes('localhost') ? 'http' : 'https';
            await fetch(`${protocol}://${host}/api/execute-trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            
            // 📱 ALERT: FORCE CLOSE
            await sendDiscordAlert(`🎯 Sniper Review: CLOSE ${trade.symbol}`, `**Action:** Force closing position.\n**Oracle:** ${verdict.reasoning}`, 15548997);
            return res.status(200).json({ status: "CLOSED", reasoning: verdict.reasoning });
        } 
        
        else if (verdict.action === 'ADJUST_LIMITS') {
            if (trade.execution_mode === 'LIVE') {
                const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
                const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', orderPath, apiKeyName, apiSecret)}` } });
                
                if (orderResp.ok) {
                    const data = await orderResp.json();
                    if (data.orders && data.orders.length > 0) {
                        const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                        await fetch(`https://api.coinbase.com${cancelPath}`, {
                            method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, 
                            body: JSON.stringify({ order_ids: data.orders.map(o => o.order_id) })
                        });
                    }
                }

                let tickSize = 0.01;
                if (coinbaseProduct.includes('ETP') || coinbaseProduct.includes('ETH')) tickSize = 0.50;
                if (coinbaseProduct.includes('BIT') || coinbaseProduct.includes('BTC')) tickSize = 1.00;

                const safeTp = verdict.tp_price ? (Math.round(verdict.tp_price / tickSize) * tickSize).toFixed(2) : null;
                const safeSl = verdict.sl_price ? (Math.round(verdict.sl_price / tickSize) * tickSize).toFixed(2) : null;

                if (safeTp && safeSl) {
                    const executePath = '/api/v3/brokerage/orders';
                    const ocoPayload = {
                        client_order_id: `nx_adj_${Date.now()}`, product_id: coinbaseProduct, side: trade.side === 'BUY' ? 'SELL' : 'BUY',
                        order_configuration: { trigger_bracket_gtc: { limit_price: safeTp.toString(), stop_trigger_price: safeSl.toString(), base_size: trade.qty.toString() } }
                    };
                    const ocoResp = await fetch(`https://api.coinbase.com${executePath}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', executePath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
                    const ocoResult = await ocoResp.json();
                    if (!ocoResp.ok || ocoResult.success === false) {
                        console.error(`[BRACKET REJECT] OCO Failed:`, JSON.stringify(ocoResult));
                        await sendDiscordAlert(`⚠️ Sniper Bracket Failed: ${trade.symbol}`, `**Action:** Failed to update TP/SL!\n**Details:** Exchange rejected the OCO order.`, 15548997);
                    }
                }
                
                await supabase.from('trade_logs').update({ 
                    tp_price: safeTp || verdict.tp_price, sl_price: safeSl || verdict.sl_price, 
                    reason: appendReason(`ADJUSTED LIMITS. ${verdict.reasoning}`) 
                }).eq('id', trade.id);

                // 📱 ALERT: ADJUST LIMITS
                await sendDiscordAlert(`🛠️ Sniper Review: ADJUSTED ${trade.symbol}`, `**New Take Profit:** $${safeTp}\n**New Stop Loss:** $${safeSl}\n**Oracle:** ${verdict.reasoning}`, 3447003);
            }

            return res.status(200).json({ status: "ADJUSTED", reasoning: verdict.reasoning });
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
        
        // --- 🛡️ THE UNIVERSAL TIMEFRAME FIX ---
        let secondsPerCandle = 3600; // Default 1 Hour
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
        // ----------------------------------------
        
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