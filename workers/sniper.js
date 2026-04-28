// workers/sniper.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import WebSocket from 'ws'; 
import { evaluateStrategy } from '../lib/strategy-router.js';
import { executeTradeMCP } from '../lib/execute-trade-mcp.js'; 

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 5.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    
    return { multiplier, tickSize };
};

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

async function fetchMacroAsset(ticker) {
    try {
        const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.ok) {
            const data = await resp.json();
            const closes = data.chart.result[0].indicators.quote[0].close.filter(p => p !== null);
            return parseFloat(closes[closes.length - 1].toFixed(2));
        }
        return null;
    } catch (e) { return null; }
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

    const start = end - (secondsPerCandle * 300); 
    const token = generateCoinbaseToken('GET', path, apiKey, secret);

    const resp = await fetch(`https://api.coinbase.com${path}?start=${start}&end=${end}&granularity=${safeGranularity}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Coinbase HTTP ${resp.status}`); 
    const data = await resp.json();
    return data.candles?.map(c => ({ open: c.open ? parseFloat(c.open) : parseFloat(c.close), close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();
  } catch (err) { throw err; } 
}

async function fetchMicrostructure(asset, triggerCandles, macroCandles, apiKey, secret) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = []; let cvd = 0; 
        const cvdCandles = triggerCandles.slice(-50);
        for (let i = 0; i < cvdCandles.length; i++) {
            const c = cvdCandles[i]; const range = c.high - c.low;
            let openPrice = c.open;
            if (isNaN(openPrice) || openPrice === undefined) { openPrice = i > 0 ? cvdCandles[i-1].close : c.close; }
            if (range > 0) { cvd += c.volume * ((c.close - openPrice) / range); }
        }

        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i]; const prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        let macro_cvd = 0; const macroCvdCandles = macroCandles.slice(-50);
        for (let i = 0; i < macroCvdCandles.length; i++) {
            const c = macroCvdCandles[i]; const range = c.high - c.low;
            let openPrice = c.open;
            if (isNaN(openPrice) || openPrice === undefined) { openPrice = i > 0 ? macroCvdCandles[i-1].close : c.close; }
            if (range > 0) { macro_cvd += c.volume * ((c.close - openPrice) / range); }
        }

        let minPrice = Infinity; let maxPrice = -Infinity; const pocCandles = macroCandles.slice(-150);
        pocCandles.forEach(c => { if (c.low < minPrice) minPrice = c.low; if (c.high > maxPrice) maxPrice = c.high; });

        const numBuckets = 50; const bucketSize = (maxPrice - minPrice) / numBuckets;
        const volumeProfile = new Array(numBuckets).fill(0);
        pocCandles.forEach(c => {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            let bucketIndex = Math.floor((typicalPrice - minPrice) / bucketSize);
            if (bucketIndex >= numBuckets) bucketIndex = numBuckets - 1; 
            if (bucketIndex < 0) bucketIndex = 0;
            volumeProfile[bucketIndex] += c.volume;
        });

        let peaks = [];
        for (let i = 1; i < numBuckets - 1; i++) {
            if (volumeProfile[i] > volumeProfile[i-1] && volumeProfile[i] > volumeProfile[i+1]) {
                peaks.push({ price: minPrice + (i * bucketSize) + (bucketSize / 2), volume: volumeProfile[i] });
            }
        }
        peaks.sort((a, b) => b.volume - a.volume);
        const macro_poc = peaks.length > 0 ? peaks[0].price : currentPrice;

        let upper_macro_node = null; let lower_macro_node = null;
        const upperPeaks = peaks.filter(p => p.price > currentPrice);
        if (upperPeaks.length > 0) upper_macro_node = upperPeaks[0].price;
        const lowerPeaks = peaks.filter(p => p.price < currentPrice);
        if (lowerPeaks.length > 0) lower_macro_node = lowerPeaks[0].price;

        let coinbaseProduct = asset.toUpperCase().trim();
        let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
        if (baseAsset === 'ETP') baseAsset = 'ETH'; else if (baseAsset === 'BIT' || baseAsset === 'BIP') baseAsset = 'BTC';
        const spotProduct = `${baseAsset}-USD`;

        let orderBookData = { status: "Unavailable" }; let basisPremium = 0; let spotPrice = currentPrice;

        if (apiKey && secret) {
            try {
                const bookPath = `/api/v3/brokerage/product_book?product_id=${coinbaseProduct}&limit=50`;
                const bookResp = await fetch(`https://api.coinbase.com${bookPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', bookPath, apiKey, secret)}` } });
                if (bookResp.ok) {
                    const bookJson = await bookResp.json();
                    const bids = bookJson.pricebook?.bids || []; const asks = bookJson.pricebook?.asks || [];
                    let totalBidSize = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    let totalAskSize = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
                    orderBookData = { bids_50_levels: (totalBidSize || 0).toFixed(2), asks_50_levels: (totalAskSize || 0).toFixed(2), imbalance: totalBidSize > totalAskSize ? "BULLISH" : "BEARISH" };
                }
            } catch (err) {}

            try {
                const productPath = `/api/v3/brokerage/products/${spotProduct}`;
                const productResp = await fetch(`https://api.coinbase.com${productPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', productPath, apiKey, secret)}` } });
                if (productResp.ok) {
                    const productJson = await productResp.json();
                    spotPrice = parseFloat(productJson.price || currentPrice);
                    basisPremium = ((currentPrice - spotPrice) / spotPrice) * 100;
                }
            } catch (err) {}
        }

        // 🟢 THE FIX: Fetch Macro context on the fly so it gets dumped straight to the database
        const [sp500, dxy] = await Promise.all([fetchMacroAsset('%5EGSPC'), fetchMacroAsset('DX-Y.NYB')]);

        return { 
            indicators: { 
                current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2), current_cvd: cvd.toFixed(2),
                macro_cvd: macro_cvd.toFixed(2), macro_poc: macro_poc.toFixed(2),
                upper_macro_node: upper_macro_node ? upper_macro_node.toFixed(2) : "None", lower_macro_node: lower_macro_node ? lower_macro_node.toFixed(2) : "None"
            }, 
            crossAsset: { sp500, dxy }, // 🟢 Added to return object
            orderBook: orderBookData, derivativesData: { spot_price: spotPrice.toFixed(2), futures_price: currentPrice.toFixed(2), basis_premium_percent: basisPremium.toFixed(4) } 
        };
    } catch (e) { return { indicators: {}, crossAsset: {}, orderBook: {}, derivativesData: {} }; }
}

const RAM = { configs: [], lastMathRun: {}, isProcessingMath: {} };
let activeProductIds = []; 

export async function startSniper() {
    console.log(`[SNIPER] Booting WebSocket Spinal Cord...`);
    const apiKeyName = process.env.COINBASE_API_KEY; const apiSecret = process.env.COINBASE_API_SECRET;
    
    let ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    const syncConfigs = async () => {
        try {
            const { data } = await supabase.from('strategy_config').select('*').eq('is_active', true);
            if (data) {
                RAM.configs = data;
                
                const newProductIds = [...new Set(data.map(c => {
                    let p = c.asset.toUpperCase().trim();
                    if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
                    return p;
                }))];

                const needsSubscription = newProductIds.some(id => !activeProductIds.includes(id));

                if (needsSubscription && ws.readyState === WebSocket.OPEN) {
                    console.log(`[SNIPER] New assets detected in database. Hot-wiring WebSocket subscriptions...`);
                    ws.send(JSON.stringify({ type: 'subscribe', product_ids: newProductIds, channel: 'ticker' }));
                    activeProductIds = newProductIds;
                }
            }
        } catch (e) { console.error("[RAM SYNC FAULT]", e.message); }
    };
    
    await syncConfigs();
    setInterval(syncConfigs, 30000); 

    ws.on('open', () => {
        console.log(`[SNIPER] WebSocket connected. Subscribing to live tape...`);
        if (activeProductIds.length > 0) {
            ws.send(JSON.stringify({ type: 'subscribe', product_ids: activeProductIds, channel: 'ticker' }));
        }
    });

    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        if (message.channel !== 'ticker' || !message.events) return;
        const tick = message.events[0].tickers[0];
        if (!tick) return;

        const currentPrice = parseFloat(tick.price);
        const wsAsset = tick.product_id;

        const activeAssetConfigs = RAM.configs.filter(c => {
            let p = c.asset.toUpperCase().trim();
            if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
            return p === wsAsset;
        });

        for (const config of activeAssetConfigs) {
            const params = config.parameters || {};

            if (config.trap_side && config.trap_price && config.trap_expires_at) {
                const expiresAt = new Date(config.trap_expires_at).getTime();
                let trapSprung = false;

                if (Date.now() > expiresAt) {
                    config.trap_side = null; 
                    await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_tp_price: null, trap_sl_price: null, trap_expires_at: null }).eq('id', config.id);
                } else if (config.trap_side === 'BUY' && currentPrice <= config.trap_price) {
                    trapSprung = true;
                } else if (config.trap_side === 'SELL' && currentPrice >= config.trap_price) {
                    trapSprung = true;
                }

                if (trapSprung) {
                    console.log(`[SNIPER] LIGHTNING TRAP SPRUNG for ${config.asset} at $${currentPrice}!`);
                    config.trap_side = null; 
                    
                    await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_tp_price: null, trap_sl_price: null, trap_expires_at: null }).eq('id', config.id);

                    let finalQty = params.qty || 1;
                    if (params.target_usd) {
                        const { multiplier } = getAssetMetrics(config.asset);
                        finalQty = Math.max(1, Math.round(params.target_usd / (currentPrice * multiplier)));
                    }

                    let trapTpPrice = config.trap_tp_price;
                    let trapSlPrice = config.trap_sl_price;

                    if (!trapTpPrice || !trapSlPrice) {
                        const slP = params.sl_percent || 0.01; const tpP = params.tp_percent || 0.02;
                        trapTpPrice = config.trap_side === 'BUY' ? currentPrice * (1 + tpP) : currentPrice * (1 - tpP);
                        trapSlPrice = config.trap_side === 'BUY' ? currentPrice * (1 - slP) : currentPrice * (1 + slP);
                    } 

                    const { tickSize } = getAssetMetrics(config.asset);

                    const trapPayload = {
                        symbol: config.asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: config.trap_side,
                        order_type: 'MARKET', price: currentPrice, 
                        tp_price: parseFloat((Math.round(trapTpPrice / tickSize) * tickSize).toFixed(4)), 
                        sl_price: parseFloat((Math.round(trapSlPrice / tickSize) * tickSize).toFixed(4)),
                        execution_mode: config.execution_mode || 'PAPER', leverage: params.leverage || 1,
                        market_type: params.market_type || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)), reason: `[VIRTUAL TRAP SPRUNG]: AI Pre-calculated R:R executed at $${currentPrice}`
                    };
                    
                    executeTradeMCP(trapPayload).catch(e => console.error("[TRAP EXECUTION FATAL]:", e.message));
                    continue; 
                }
            }

            const now = Date.now();
            const lastRun = RAM.lastMathRun[config.id] || 0;
            const isProcessing = RAM.isProcessingMath[config.id] || false;

            if (isProcessing || (now - lastRun < 60000)) continue; 

            RAM.isProcessingMath[config.id] = true;
            RAM.lastMathRun[config.id] = now;
            await supabase.from('strategy_config').update({ is_processing: true }).eq('id', config.id);

            try {
                const cooldownMins = params.veto_cooldown_minutes || 15;
                const lastVeto = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
                const isCooldownActive = (Date.now() - lastVeto) < (cooldownMins * 60000);

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

                // 🟢 THE FIX: Dump the macro data straight to the database for the UI Audit view
                decision.telemetry = { 
                    ...decision.telemetry, 
                    macro_poc: microstructure.indicators.macro_poc, upper_macro_node: microstructure.indicators.upper_macro_node, lower_macro_node: microstructure.indicators.lower_macro_node,
                    macro_cvd: microstructure.indicators.macro_cvd, cvd: microstructure.indicators.current_cvd, 
                    sp500: microstructure.crossAsset?.sp500 || "N/A", // LOG TO DATABASE
                    dxy: microstructure.crossAsset?.dxy || "N/A",     // LOG TO DATABASE
                    bids: microstructure.orderBook.bids_50_levels || 0, asks: microstructure.orderBook.asks_50_levels || 0, premium: microstructure.derivativesData.basis_premium_percent || 0,
                    open_position: openTrade ? `${openTrade.side} @ $${openTrade.entry_price}` : "NONE",
                    open_tp: openTrade?.tp_price || "NONE",
                    open_sl: openTrade?.sl_price || "NONE",
                    open_pnl: openTrade ? (openTrade.pnl || 0) : 0,
                    macro_regime_oracle: "EVALUATING", oracle_reasoning: "Awaiting signal..."
                };

                if (decision.signal) {
                    if (isCooldownActive) {
                        decision.statusOverride = `COOLDOWN (${cooldownMins}M)`;
                        decision.telemetry.oracle_reasoning = `System in penalty box. Ignoring ${decision.signal} signal.`;
                    } else {
                        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
                        console.log(`[SNIPER] Math signal detected for ${config.asset}. Waking Hermes...`);
                        
                        // 🟢 THE FIX: Pass the config.active_thesis into the LLM as the Rolling Ledger memory base
                        await pingHermes({
                            asset: config.asset,
                            mode: "ENTRY",
                            message: `Mathematical Strategy ${config.strategy} just fired a ${normalizedSignal} signal for ${config.asset} at $${currentPrice}. Please fetch get_market_state, evaluate the X-Ray data against your SKILL.md memory, and use execute_order if you approve.`,
                            openTrade: openTrade || null,
                            previous_thesis: config.active_thesis || "No previous thesis recorded.",
                            candles: triggerCandles.slice(-50),
                            indicators: microstructure.indicators,
                            macro_tf: macroTf,
                            trigger_tf: triggerTf,
                            execution_mode: config.execution_mode,
                            strategy_id: config.strategy,
                            version: config.version
                        });

                        await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('id', config.id);

                        decision.statusOverride = 'HERMES_NOTIFIED';
                        decision.telemetry.oracle_reasoning = "Ping sent to Agent Cortex. Awaiting autonomous execution or veto.";
                        decision.telemetry.macro_regime_oracle = "HANDED TO AGENT";
                    }
                }

                const finalStatus = decision.statusOverride || (decision.signal ? "RESONANT" : "STABLE");
                await supabase.from('scan_results').insert([{ strategy: config.strategy, asset: config.asset, telemetry: decision.telemetry, status: finalStatus }]);

            } catch (e) { console.error(`[ASSET ERROR] ${config.asset}:`, e.message); }
            finally {
                RAM.isProcessingMath[config.id] = false;
                await supabase.from('strategy_config').update({ is_processing: false }).eq('id', config.id);
            }
        }
    });

    ws.on('close', () => { setTimeout(startSniper, 5000); });
    ws.on('error', (err) => { console.error('[SNIPER] WebSocket Error:', err.message); });
}