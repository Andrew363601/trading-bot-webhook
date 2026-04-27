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
    
    const token = generateCoinbaseToken('GET', path, apiKey, secret);

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

        // --- MACRO CVD CALCULATION ---
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

        // --- POINT OF CONTROL (POC) ENGINE ---
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

        // Map all local maxima
        let peaks = [];
        for (let i = 1; i < numBuckets - 1; i++) {
            if (volumeProfile[i] > volumeProfile[i-1] && volumeProfile[i] > volumeProfile[i+1]) {
                peaks.push({
                    price: minPrice + (i * bucketSize) + (bucketSize / 2),
                    volume: volumeProfile[i]
                });
            }
        }
        if (volumeProfile[0] > volumeProfile[1]) peaks.push({ price: minPrice + (bucketSize / 2), volume: volumeProfile[0] });
        if (volumeProfile[numBuckets - 1] > volumeProfile[numBuckets - 2]) peaks.push({ price: minPrice + ((numBuckets - 1) * bucketSize) + (bucketSize / 2), volume: volumeProfile[numBuckets - 1] });

        peaks.sort((a, b) => b.volume - a.volume);

        const macro_poc = peaks.length > 0 ? peaks[0].price : currentPrice;

        let upper_macro_node = null;
        let lower_macro_node = null;

        const upperPeaks = peaks.filter(p => p.price > currentPrice);
        if (upperPeaks.length > 0) upper_macro_node = upperPeaks[0].price;

        const lowerPeaks = peaks.filter(p => p.price < currentPrice);
        if (lowerPeaks.length > 0) lower_macro_node = lowerPeaks[0].price;

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
                macro_cvd: macro_cvd.toFixed(2),
                macro_poc: macro_poc.toFixed(2),
                upper_macro_node: upper_macro_node ? upper_macro_node.toFixed(2) : "None",
                lower_macro_node: lower_macro_node ? lower_macro_node.toFixed(2) : "None"
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