// workers/sniper.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import WebSocket from 'ws'; 
import { evaluateStrategy } from '../lib/strategy-router.js';
import { executeTradeMCP } from '../lib/execute-trade-mcp.js'; 
import { isTenantBillingActive, deactivateTenantStrategies } from '../lib/tenant-context.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { 
    global: { WebSocket: WebSocket },
    realtime: { transport: WebSocket }
  }
);

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

// 🟢 THE FIX: Rate Limiter & Caching for Coinbase API
const requestQueue = [];
let processingQueue = false;
const candleCache = new Map();
const CACHE_TTL = 30000; // 30 seconds
const MAX_RPS = 8; // Max requests per second

async function processRequestQueue() {
    if (processingQueue) return;
    processingQueue = true;
    
    while (requestQueue.length > 0) {
        const batch = requestQueue.splice(0, MAX_RPS);
        const startTime = Date.now();
        
        await Promise.all(batch.map(fn => fn()));
        
        const elapsed = Date.now() - startTime;
        if (elapsed < 1000) {
            await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
        }
    }
    
    processingQueue = false;
}

async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
  const cacheKey = `${asset}_${granularity}`;
  const cached = candleCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  return new Promise((resolve, reject) => {
    requestQueue.push(async () => {
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
        const result = data.candles?.map(c => ({ open: c.open ? parseFloat(c.open) : parseFloat(c.close), close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();
        
        // Cache the result
        candleCache.set(cacheKey, { data: result, timestamp: Date.now() });
        
        resolve(result);
      } catch (err) { 
        reject(err); 
      }
    });
    
    processRequestQueue();
  });
}

// 🟢 Helper functions required by the Sniper
const getCVDSequence = (candles, sequenceLength = 5) => {
    if (!candles || candles.length === 0) return [];
    const seq = [];
    const targetCandles = candles.slice(-sequenceLength);
    for (let i = 0; i < targetCandles.length; i++) {
        const c = targetCandles[i];
        const range = c.high - c.low;
        let openPrice = c.open !== undefined && !isNaN(c.open) ? c.open : c.close; 
        let cvd = 0;
        if (range > 0) {
            cvd = c.volume * ((c.close - openPrice) / range);
        }
        seq.push(parseFloat(cvd.toFixed(2)));
    }
    return seq;
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
        // Hoisted to function scope so the regime classifier below can read them
        // even when the Coinbase order book fetch is skipped (no apiKey/secret).
        let totalBidSize = 0; let totalAskSize = 0;

        if (apiKey && secret) {
            try {
                const bookPath = `/api/v3/brokerage/product_book?product_id=${coinbaseProduct}&limit=50`;
                const bookResp = await fetch(`https://api.coinbase.com${bookPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', bookPath, apiKey, secret)}` } });
                if (bookResp.ok) {
                    const bookJson = await bookResp.json();
                    const bids = bookJson.pricebook?.bids || []; const asks = bookJson.pricebook?.asks || [];
                    
                    // 🟢 THE UPGRADE: Deep X-Ray Vision (Top 3 Walls)
                    const parsedBids = bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size || 0) })).sort((a, b) => b.size - a.size);
                    const parsedAsks = asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size || 0) })).sort((a, b) => b.size - a.size);
                    
                    totalBidSize = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    totalAskSize = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

                    orderBookData = { 
                        bids_50_levels: totalBidSize.toFixed(2), 
                        asks_50_levels: totalAskSize.toFixed(2), 
                        imbalance: totalBidSize > totalAskSize ? "BULLISH" : "BEARISH",
                        largest_bid_walls: parsedBids.slice(0, 3),
                        largest_ask_walls: parsedAsks.slice(0, 3)
                    };
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

        const [sp500, dxy] = await Promise.all([fetchMacroAsset('%5EGSPC'), fetchMacroAsset('DX-Y.NYB')]);

        // --- 4-State Regime Classifier ---
        // Source of truth for market regime. Uses price distance from macro POC
        // (in ATR terms), directional CVD, and order book bid/ask imbalance.
        const priceDist = Math.abs(currentPrice - macro_poc);
        const atrRatio = priceDist / Math.max(atr, 0.01);
        const cvdValue = parseFloat(macro_cvd) || 0;
        const bidAskRatio = totalBidSize / Math.max(totalAskSize, 0.01);
        let detectedRegime;

        if (atrRatio > 1.5 && Math.abs(cvdValue) > 5) {
            // Price broke away from POC (>1.5 ATR) and CVD is strongly directional
            detectedRegime = "TREND";
        } else if (atrRatio < 1.0 && cvdValue > 2 && bidAskRatio > 1.2) {
            // Price near POC, bullish CVD, order book showing bid stacking
            detectedRegime = "ACCUMULATION";
        } else if (atrRatio < 1.0 && cvdValue < -2 && bidAskRatio < 0.8) {
            // Price near POC, bearish CVD, order book showing ask stacking
            detectedRegime = "DISTRIBUTION";
        } else {
            detectedRegime = "CHOP";
        }

        return {
            macro_regime: detectedRegime,
            indicators: { 
                current_vwap: vwap.toFixed(2), current_atr: atr.toFixed(2), current_cvd: cvd.toFixed(2),
                macro_cvd: macro_cvd.toFixed(2), macro_poc: macro_poc.toFixed(2),
                upper_macro_node: upper_macro_node ? upper_macro_node.toFixed(2) : "None", lower_macro_node: lower_macro_node ? lower_macro_node.toFixed(2) : "None"
            }, 
            crossAsset: { sp500, dxy }, 
            orderBook: orderBookData, derivativesData: { spot_price: spotPrice.toFixed(2), futures_price: currentPrice.toFixed(2), basis_premium_percent: basisPremium.toFixed(4) } 
        };
    } catch (e) { return { indicators: {}, crossAsset: {}, orderBook: {}, derivativesData: {} }; }
}

// ── CORE MEMORY SCORING HELPERS ──
function wordOverlap(textA, textB) {
    if (!textA || !textB) return 0;
    const wordsA = new Set(textA.toLowerCase().split(/\W+/).filter(Boolean));
    const wordsB = new Set(textB.toLowerCase().split(/\W+/).filter(Boolean));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
}

async function getScoredMemories(tenantId, asset, currentRegime, signalDirection) {
    try {
        // Check if this tenant has opted into the cross-tenant memory pool
        let shareMemory = true;
        try {
            const { data: settings } = await supabase
                .from('tenant_settings')
                .select('share_memory')
                .eq('tenant_id', tenantId)
                .single();
            if (settings) shareMemory = settings.share_memory !== false;
        } catch (e) { /* non-fatal — default to shared */ }

        let query = supabase
            .from('hermes_core_memory')
            .select('id, tenant_id, win_loss, tools_used, lesson_learned, pnl, execution_mode, regime_at_close, created_at, working_thesis, thesis_accurate')
            .eq('asset', asset)
            .order('created_at', { ascending: false })
            .limit(50);

        if (!shareMemory) {
            query = query.eq('tenant_id', tenantId);
        }

        const { data: rawMemories } = await query;
        const allMemories = rawMemories || [];

        if (!allMemories || allMemories.length === 0) {
            return { memories: [], ids: [], text: "No core memory available for this asset." };
        }

        // Anonymize cross-tenant memories — strip tenant_id so the receiving
        // tenant never sees who the lesson belongs to. Own-tenant memories
        // keep tenant_id for the scoring bonus below.
        const ownTenantId = tenantId;
        for (const m of allMemories) {
            if (m.tenant_id !== ownTenantId) {
                delete m.tenant_id;
            }
        }

        const now = Date.now();
        const MAX_TRACKED_PNL = 1000;
        const MAX_RECURRENCE = 5;

        // 3j) Shadow Portfolio bonus (0 to ±30 points, minimum 5 records)
        // VETOs that saved money → pattern confirmed → bonus
        // VETOs that missed profit → pattern needs challenge → penalty
        let shadowBonus = 0;
        try {
            const { data: shadowStats } = await supabase
                .from('shadow_portfolio')
                .select('verdict')
                .eq('asset', asset)
                .eq('tenant_id', tenantId)
                .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString());

            if (shadowStats && shadowStats.length >= 5) {
                const savedCount = shadowStats.filter(s => s.verdict === 'SAVED').length;
                const totalCount = shadowStats.length;
                const savedRatio = savedCount / totalCount;
                
                if (savedRatio > 0.7) shadowBonus = 30;
                else if (savedRatio > 0.5) shadowBonus = 15;
                else if (savedRatio < 0.3) shadowBonus = -20;
                
                console.log(`[SHADOW SCORE] ${asset}: ${savedCount}/${totalCount} SAVED (${(savedRatio*100).toFixed(0)}%) → bonus=${shadowBonus}`);
            }
        } catch (e) {
            console.error('[SHADOW SCORE] Query failed:', e.message);
        }

        // Score each memory — multiplicative regime & accuracy, additive everything else
        const scored = allMemories.map(m => {
            // 3a) Recency score (0-100 points, decays 1 point per day)
            const ageHours = (now - new Date(m.created_at).getTime()) / (1000 * 60 * 60);
            const recency = Math.max(0, 100 - (ageHours / 24));

            // 3b) PnL impact score (0-100 points, capped at $1000)
            const absPnl = Math.abs(parseFloat(m.pnl) || 0);
            const pnlImpact = Math.min(absPnl, MAX_TRACKED_PNL) / MAX_TRACKED_PNL * 100;

            // 3c) Working thesis similarity (0-50 points)
            let thesisSim = 0;
            if (m.working_thesis && signalDirection) {
                const directionWords = signalDirection === 'BUY'
                    ? 'long buy approve bull'
                    : 'short sell veto bear';
                thesisSim = wordOverlap(m.working_thesis.toLowerCase(), directionWords) * 50;
            }

            // 3d) Base score = recency + thesis similarity (things that always apply)
            let baseScore = recency + thesisSim;

            // 3e) Regime match multiplies base by 1.5x
            // Same market conditions make a memory FAR more applicable
            const regimeMultiplier = (currentRegime && m.regime_at_close === currentRegime) ? 1.5 : 1.0;

            // 3f) Accuracy & PnL multiplier tiers:
            //    - Accurate + high PnL (>50) = validated thesis, ×1.2
            //    - Accurate only = base (×1.0)
            //    - Inaccurate + high PnL (>50) = expensive mistake, ×0.8
            //    - Inaccurate only = wrong thesis, ×0.75
            //    - NULL/unknown = neutral (×1.0)
            let accPnlMultiplier = 1.0;
            if (m.thesis_accurate === true) {
                if (pnlImpact > 50) {
                    accPnlMultiplier = 1.2;  // ✅ Right AND made real money
                }
            } else if (m.thesis_accurate === false) {
                if (pnlImpact > 50) {
                    accPnlMultiplier = 0.8;  // ❌ Wrong AND expensive
                } else {
                    accPnlMultiplier = 0.75; // ❌ Wrong thesis
                }
            }

            // 3g) Combined multiplier (regime × accuracy-PnL)
            const multiplier = regimeMultiplier * accPnlMultiplier;

            // 3h) LIVE weight (0 or 50 points)
            const liveWt = (m.execution_mode === 'LIVE') ? 50 : 0;

            // 3i) Own-tenant bonus (0 or 5 points) — pure tiebreaker
            const ownBonus = (m.tenant_id === ownTenantId) ? 5 : 0;

            // Total = (base × multiplier) + additive bonuses
            const total = (baseScore * multiplier) + pnlImpact + liveWt + ownBonus + shadowBonus;

            return { ...m, score: Math.round(total) };
        });

        // 3f) Recurrence bonus (second pass — count similar lessons)
        for (const m of scored) {
            const similarCount = scored.filter(other =>
                wordOverlap(m.lesson_learned, other.lesson_learned) > 0.5
            ).length;
            m.score += Math.min(similarCount - 1, MAX_RECURRENCE) * 10;
        }

        // Sort by score descending, take top 3
        scored.sort((a, b) => b.score - a.score);
        const top3 = scored.slice(0, 3);
        return {
            memories: top3,
            ids: top3.map(m => m.id),
            text: top3.map(m =>
                `[Past ${m.win_loss} | Score: ${m.score} | Regime: ${m.regime_at_close || 'ANY'} | Thesis: ${m.working_thesis || 'No thesis'} | Accurate: ${m.thesis_accurate ?? 'N/A'}]: ${m.lesson_learned}`
            ).join('\n')
        };
    } catch (e) {
        console.error(`[MEMORY SCORING] Error for ${asset}:`, e.message);
        return { memories: [], ids: [], text: "No core memory available for this asset." };
    }
}

const tenantRAM = new Map(); // tenantId => { configs, lastMathRun, isProcessingMath, activeProductIds, trapLocks }

function getTenantState(tenantId) {
    if (!tenantRAM.has(tenantId)) {
        tenantRAM.set(tenantId, { configs: [], lastMathRun: {}, isProcessingMath: {}, activeProductIds: [], trapLocks: new Map() });
    }
    return tenantRAM.get(tenantId);
}

export async function startSniper(tenantId) {
    const state = getTenantState(tenantId);
    await logAgentActivity(tenantId, "Sniper", "N/A", "Sniper worker started.", "WORKER_START");
    console.log(`[SNIPER-${tenantId}] Booting WebSocket Spinal Cord...`);
    const apiKeyName = process.env.COINBASE_API_KEY; const apiSecret = process.env.COINBASE_API_SECRET;
    
    let ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    const syncConfigs = async () => {
        try {
            // 🔒 BILLING GUARD (defense-in-depth): workers bypass RLS via the service role,
            // so we must independently verify the tenant is allowed to trade. If billing is
            // inactive (canceled / trial expired / past due), force strategies off and stop.
            const billing = await isTenantBillingActive(tenantId);
            if (!billing.active) {
                if (state.configs && state.configs.length > 0) {
                    await deactivateTenantStrategies(tenantId, billing.reason);
                    await logAgentActivity(tenantId, "Sniper", "N/A", `Trading halted — ${billing.reason}. All strategies deactivated.`, "BILLING_HALT");
                }
                state.configs = [];
                return;
            }

            const { data } = await supabase.from('strategy_config').select('*').eq('tenant_id', tenantId).eq('is_active', true);
            if (data) {
                state.configs = data;
                await logAgentActivity(tenantId, "Sniper", "N/A", `Synced ${data.length} active strategies.`, "CONFIG_SYNC");
                
                const newProductIds = [...new Set(data.map(c => {
                    let p = c.asset.toUpperCase().trim();
                    if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
                    return p;
                }))];

                const needsSubscription = newProductIds.some(id => !state.activeProductIds.includes(id));

                if (needsSubscription && ws.readyState === WebSocket.OPEN) {
                    console.log(`[SNIPER] New assets detected in database. Hot-wiring WebSocket subscriptions...`);
                    ws.send(JSON.stringify({ type: 'subscribe', product_ids: newProductIds, channel: 'ticker' }));
                    state.activeProductIds = newProductIds;
                }
            }
        } catch (e) { console.error("[RAM SYNC FAULT]", e.message); }
    };
    
    await syncConfigs();
    setInterval(syncConfigs, 30000); 

    ws.on('open', async () => {
        await logAgentActivity(tenantId, "Sniper", "N/A", "WebSocket connected. Subscribing to live tape...", "WEBSOCKET_CONNECT");
        console.log(`[SNIPER] WebSocket connected. Subscribing to live tape...`);
        if (state.activeProductIds.length > 0) {
            ws.send(JSON.stringify({ type: 'subscribe', product_ids: state.activeProductIds, channel: 'ticker' }));
        }
    });

    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        if (message.channel !== 'ticker' || !message.events) return;
        const tick = message.events[0].tickers[0];
        if (!tick) return;

        const currentPrice = parseFloat(tick.price);
        const wsAsset = tick.product_id;

        const activeAssetConfigs = state.configs.filter(c => {
            let p = c.asset.toUpperCase().trim();
            if (!p.includes('-')) p = p.replace('PERP', '-PERP').replace('USD', '-USD');
            return p === wsAsset;
        });

        for (const config of activeAssetConfigs) {
            const params = config.parameters || {};

            if (config.trap_side && config.trap_price && config.trap_expires_at) {
                // 🔒 TRAP LOCK: Prevent double-trigger from rapid WebSocket ticks
                if (state.trapLocks.get(config.id)) continue;
                state.trapLocks.set(config.id, true);

                const expiresAt = new Date(config.trap_expires_at).getTime();
                let trapSprung = false;
                let trapSide = config.trap_side; // capture before any mutation

                if (Date.now() > expiresAt) {
                    config.trap_side = null; 
                    await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_tp_price: null, trap_sl_price: null, trap_expires_at: null }).eq('id', config.id).eq('tenant_id', tenantId);
                } else if (trapSide === 'BUY' && currentPrice <= config.trap_price) {
                    trapSprung = true;
                } else if (trapSide === 'SELL' && currentPrice >= config.trap_price) {
                    trapSprung = true;
                }

                if (trapSprung) {
                    await logAgentActivity(tenantId, "Sniper", config.asset, `LIGHTNING TRAP SPRUNG for ${config.asset} at $${currentPrice}!`, "TRAP_SPRUNG");
                    console.log(`[SNIPER] LIGHTNING TRAP SPRUNG for ${config.asset} at $${currentPrice}!`);
                    
                    let finalQty = params.qty || 1;
                    if (params.target_usd) {
                        const { multiplier } = getAssetMetrics(config.asset);
                        finalQty = Math.max(1, Math.round(params.target_usd / (currentPrice * multiplier)));
                    }

                    let trapTpPrice = config.trap_tp_price;
                    let trapSlPrice = config.trap_sl_price;

                    if (!trapTpPrice || !trapSlPrice) {
                        const slP = params.sl_percent || 0.01; const tpP = params.tp_percent || 0.02;
                        trapTpPrice = trapSide === 'BUY' ? currentPrice * (1 + tpP) : currentPrice * (1 - tpP);
                        trapSlPrice = trapSide === 'BUY' ? currentPrice * (1 - slP) : currentPrice * (1 + slP);
                    } 

                    const { tickSize } = getAssetMetrics(config.asset);

                    const trapPayload = {
                        tenant_id: tenantId,
                        symbol: config.asset, strategy_id: config.strategy, version: config.version || 'v1.0', side: trapSide,
                        order_type: 'MARKET', price: currentPrice, 
                        tp_price: parseFloat((Math.round(trapTpPrice / tickSize) * tickSize).toFixed(4)), 
                        sl_price: parseFloat((Math.round(trapSlPrice / tickSize) * tickSize).toFixed(4)),
                        execution_mode: config.execution_mode || 'PAPER', leverage: params.leverage || 1,
                        market_type: params.market_type || 'FUTURES', qty: parseFloat(finalQty.toFixed(2)), 
                        reason: `[VIRTUAL TRAP SPRUNG]: AI Pre-calculated R:R executed at $${currentPrice}\n\n**Original Thesis:** ${config.active_thesis || 'None Recorded'}`,
                        working_thesis: config.active_thesis
                    };
                    
                    config.trap_side = null; 
                    // 🛡️ DB ATOMICITY: Only clear trap in DB if it hasn't already been cleared (race condition guard)
                    const { data: stillSet } = await supabase.from('strategy_config')
                        .select('trap_side')
                        .eq('id', config.id)
                        .eq('tenant_id', tenantId)
                        .eq('trap_side', trapSide)
                        .maybeSingle();

                    if (stillSet) {
                        await supabase.from('strategy_config').update({ trap_side: null, trap_price: null, trap_tp_price: null, trap_sl_price: null, trap_expires_at: null }).eq('id', config.id).eq('tenant_id', tenantId);
                    } else {
                        // Another tick already cleared the trap — skip execution to prevent double-trade
                        console.log(`[SNIPER] Trap for ${config.asset} was already cleared by another tick. Suppressing duplicate execution.`);
                        state.trapLocks.delete(config.id);
                        continue;
                    }

                                        // Simple in-memory lock to avoid duplicate trap executions for same asset/tenant
                                        const trapLockKey = `${tenantId}:${config.asset}:${trapSide}`;
                                        if (!global.__trapLocks) global.__trapLocks = new Set();
                                        if (global.__trapLocks.has(trapLockKey)) {
                                            console.log(`[SNIPER-LOCK] Skipping trap execution for ${trapLockKey} (already running)`);
                                            continue;
                                        }
                                        global.__trapLocks.add(trapLockKey);

                                        // 🟢 Fetch scored memories for trap payload
                                        // so influencing_memory_ids are stored in trade_logs.
                                        let trapMemoryIds = [];
                                        try {
                                            const scoredResult = await getScoredMemories(tenantId, config.asset, null, null);
                                            if (scoredResult?.ids?.length > 0) trapMemoryIds = scoredResult.ids;
                                        } catch (e) {
                                            console.log(`[SNIPER-TRAP] Scored memory fetch failed (non-fatal): ${e.message}`);
                                        }

                                        // Augment trapPayload with memory IDs
                                        trapPayload._influencing_memory_ids = trapMemoryIds;

                                        // Execute synchronously to prevent race conditions
                                        try {
                                            const result = await executeTradeMCP(trapPayload);
                                            logAgentActivity(tenantId, "Sniper", config.asset, `Trade executed for TRAP: ${trapSide} ${finalQty} ${config.asset} @ $${currentPrice}.`, "TRADE_EXECUTION");
                                        } catch (e) {
                                            console.error(`[SNIPER-${tenantId}] TRAP EXECUTION FATAL:`, e.message);
                                            logAgentActivity(tenantId, "Sniper", config.asset, `TRAP EXECUTION FAILED for ${config.asset}: ${e.message}`, "ERROR");
                                        } finally {
                                            global.__trapLocks.delete(trapLockKey);
                                        }
                    
                    state.trapLocks.delete(config.id);
                    continue; 
                }
                
                state.trapLocks.delete(config.id);
            }

            const now = Date.now();
            const lastRun = state.lastMathRun[config.id] || 0;
            const isProcessing = state.isProcessingMath[config.id] || false;

            if (isProcessing || (now - lastRun < 60000)) continue; 

            state.isProcessingMath[config.id] = true;
            state.lastMathRun[config.id] = now;
            await supabase.from('strategy_config').update({ is_processing: true }).eq('id', config.id).eq('tenant_id', tenantId);
            await logAgentActivity(tenantId, "Sniper", config.asset, `Starting strategy evaluation for ${config.strategy} on ${config.asset}.`, "STRATEGY_EVAL_START");

            try {
                const cooldownMins = params.veto_cooldown_minutes || 15;
                const lastVeto = config.last_veto_time ? new Date(config.last_veto_time).getTime() : 0;
                const isCooldownActive = (Date.now() - lastVeto) < (cooldownMins * 60000);

                const macroTf = params.macro_tf || 'ONE_HOUR';
                const triggerTf = params.trigger_tf || 'FIVE_MINUTE';

                const [macroCandles, triggerCandles, candles15M, candles30M, candles6H, candles5M, candles1H] = await Promise.all([
                    fetchCoinbaseData(config.asset, macroTf, apiKeyName, apiSecret),
                    fetchCoinbaseData(config.asset, triggerTf, apiKeyName, apiSecret),
                    fetchCoinbaseData(config.asset, 'FIFTEEN_MINUTE', apiKeyName, apiSecret).catch(() => []),
                    fetchCoinbaseData(config.asset, 'THIRTY_MINUTE', apiKeyName, apiSecret).catch(() => []),
                    fetchCoinbaseData(config.asset, 'SIX_HOUR', apiKeyName, apiSecret).catch(() => []),
                    triggerTf === 'FIVE_MINUTE' ? Promise.resolve(null) : fetchCoinbaseData(config.asset, 'FIVE_MINUTE', apiKeyName, apiSecret).catch(() => []),
                    macroTf === 'ONE_HOUR' ? Promise.resolve(null) : fetchCoinbaseData(config.asset, 'ONE_HOUR', apiKeyName, apiSecret).catch(() => [])
                ]);

                if (!macroCandles || !triggerCandles) continue;

                const c5m = triggerTf === 'FIVE_MINUTE' ? triggerCandles : candles5M;
                const c1h = macroTf === 'ONE_HOUR' ? macroCandles : candles1H;

                const momentumMatrix = {
                    '5M_Seq': getCVDSequence(c5m, 5),
                    '15M_Seq': getCVDSequence(candles15M, 5),
                    '30M_Seq': getCVDSequence(candles30M, 5),
                    '1H_Seq': getCVDSequence(c1h, 5),
                    '6H_Seq': getCVDSequence(candles6H, 5)
                };

                const microstructure = await fetchMicrostructure(config.asset, triggerCandles, macroCandles, apiKeyName, apiSecret);
                
                const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', config.asset).eq('strategy_id', config.strategy).eq('tenant_id', tenantId).is('exit_price', null).limit(1);
                const openTrade = openTrades?.[0];

                let decision = await evaluateStrategy(config.strategy, { macro: macroCandles, trigger: triggerCandles }, params);

                decision.telemetry = { 
                    ...decision.telemetry, 
                    macro_poc: microstructure.indicators.macro_poc, upper_macro_node: microstructure.indicators.upper_macro_node, lower_macro_node: microstructure.indicators.lower_macro_node,
                    macro_cvd: microstructure.indicators.macro_cvd, cvd: microstructure.indicators.current_cvd, 
                    sp500: microstructure.crossAsset?.sp500 || "N/A", 
                    dxy: microstructure.crossAsset?.dxy || "N/A",     
                    bids: microstructure.orderBook.bids_50_levels || 0, asks: microstructure.orderBook.asks_50_levels || 0, premium: microstructure.derivativesData.basis_premium_percent || 0,
                    open_position: openTrade ? `${openTrade.side} @ $${openTrade.entry_price}` : (config.trap_side ? `TRAP ${config.trap_side} @ $${config.trap_price}` : "NONE"),
                    open_tp: openTrade?.tp_price || "NONE",
                    open_sl: openTrade?.sl_price || "NONE",
                    open_pnl: openTrade ? (openTrade.pnl || 0) : 0,
                    macro_regime_oracle: microstructure?.macro_regime || "EVALUATING", oracle_reasoning: "Awaiting signal..."
                };

                let scanId = null;
                if (decision.signal) {
                    await logAgentActivity(tenantId, "Sniper", config.asset, `Signal detected: ${decision.signal} for ${config.strategy}.`, "SIGNAL_DETECTED");
                    if (isCooldownActive) {
                        decision.statusOverride = `COOLDOWN (${cooldownMins}M)`;
                        decision.telemetry.oracle_reasoning = `System in penalty box. Ignoring ${decision.signal} signal.`;
                    } else {
                        const normalizedSignal = (decision.signal === 'LONG' || decision.signal === 'BUY') ? 'BUY' : 'SELL';
                        console.log(`[SNIPER-${tenantId}] Math signal detected for ${config.asset}. Fetching Core Memory & Waking Hermes...`);
                        
                        // 🟢 Pre-create scan_results row so scan_id can be passed to Hermes and agent_tool_calls
                        try {
                            const preTelemetry = { 
                                ...decision.telemetry, 
                                status_overlay: "HANDED TO AGENT", 
                                oracle_reasoning: "Ping sent to Agent Cortex. Awaiting autonomous execution or veto." 
                            };
                            const { data: scanRow, error: scanErr } = await supabase
                                .from('scan_results')
                                .insert([{
                                    tenant_id: tenantId,
                                    strategy: config.strategy,
                                    asset: config.asset,
                                    telemetry: preTelemetry,
                                    status: 'HERMES_NOTIFIED'
                                }])
                                .select('id')
                                .single();
                            if (!scanErr && scanRow?.id) {
                                scanId = scanRow.id;
                            }
                        } catch (sErr) {
                            console.warn(`[SNIPER-${tenantId}] Pre-scan creation failed:`, sErr.message);
                        }

                        const currentRegime = config.parameters?.regime 
                            || microstructure?.macro_regime 
                            || null;

                        const scoredResult = await getScoredMemories(tenantId, config.asset, currentRegime, normalizedSignal);
                        const scoredMemories = scoredResult.memories || [];
                        const memoryString = scoredResult.text || "No core memory available for this asset.";
                        const memoryIds = scoredResult.ids || [];

                        let shadowLine = '';
                        try {
                            const { data: shadowStats } = await supabase
                                .from('shadow_portfolio')
                                .select('verdict, saved_amount, missed_amount')
                                .eq('asset', config.asset)
                                .eq('tenant_id', tenantId)
                                .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString());

                            if (shadowStats && shadowStats.length >= 3) {
                                const savedCount = shadowStats.filter(s => s.verdict === 'SAVED').length;
                                const missedCount = shadowStats.filter(s => s.verdict === 'MISSED').length;
                                const totalCount = shadowStats.length;
                                const savedRatio = (savedCount / totalCount * 100).toFixed(0);
                                
                                let pattern = '';
                                if (savedRatio > 70) pattern = '⚠ Your VETOs on this asset are mostly correct. Trust your caution.';
                                else if (savedRatio < 30) pattern = '⚠ Your VETOs on this asset are mostly wrong. Consider taking more trades.';
                                else pattern = 'Mixed VETO track record — evaluate each signal on its merits.';
                                
                                shadowLine = `\n\n--- SHADOW PORTFOLIO (${config.asset}, 7d) ---\n✅ SAVED: ${savedCount}/${totalCount} (${savedRatio}%)\n❌ MISSED: ${missedCount}/${totalCount}\n${pattern}`;
                            }
                        } catch (e) { /* non-fatal */ }

                        let activeTrapMessage = "";
                        if (!openTrade && config.trap_side && config.trap_price) {
                            const timeRemaining = Math.max(0, Math.round((new Date(config.trap_expires_at).getTime() - Date.now()) / 60000));
                            activeTrapMessage = `\n\n⚠️ ACTIVE GHOST TRAP ALERT:\nYou currently have an open VIRTUAL_TRAP set to ${config.trap_side} at $${config.trap_price} with ${timeRemaining}m remaining. Your previous working thesis was: "${config.active_thesis || 'None'}". Evaluate this new math signal against your previous thesis and decide if you should HOLD the existing trap, UPDATE it to a new level, or VETO to cancel the trap completely.`;
                        }

                        // 🟢 THE UPGRADE: Injecting Top 3 Walls into the Hermes Prompt
                        const bidWallsText = microstructure.orderBook.largest_bid_walls?.map((w, i) => `#${i+1}: ${w.size} contracts @ $${w.price}`).join('\n') || "None";
                        const askWallsText = microstructure.orderBook.largest_ask_walls?.map((w, i) => `#${i+1}: ${w.size} contracts @ $${w.price}`).join('\n') || "None";

                        await pingHermes({
                            tenant_id: tenantId,
                            asset: config.asset,
                            scan_id: scanId,
                            mode: "ENTRY",
                            message: `Mathematical Strategy ${config.strategy} just fired a ${normalizedSignal} signal for ${config.asset} at $${currentPrice}.\n\nCORE MEMORY (Past Lessons for this asset):\n${memoryString}${shadowLine}\n\nFRACTAL MOMENTUM MATRIX (Last 5 CVDs):\n${JSON.stringify(momentumMatrix, null, 2)}\n\nLIQUIDITY MAP (Order Book Top 3 Walls):\nBIDS:\n${bidWallsText}\n\nASKS:\n${askWallsText}${activeTrapMessage}\n\nPlease fetch get_market_state, evaluate the X-Ray data against your SKILL.md memory, and use execute_order if you approve.\n\n── ALPHA HARVESTING FRAME ──\nThis is a new signal arriving while no trade is open. Your thesis and outcome will be stored in core memory and scored for future signals. Write your working_thesis for future-self: market context, the specific alpha edge, and your exit conditions.`,
                            openTrade: openTrade || null,
                            previous_thesis: config.active_thesis || "No previous thesis recorded.",
                            candles: triggerCandles.slice(-50),
                            indicators: microstructure.indicators,
                            macro_tf: macroTf,
                            trigger_tf: triggerTf,
                            execution_mode: config.execution_mode,
                            strategy_id: config.strategy,
                            version: config.version,
                            qty: params.qty || 1,
                            memoryIds: memoryIds
                        });
                        await logAgentActivity(tenantId, "Sniper", config.asset, `Hermes notified about ${normalizedSignal} signal for ${config.asset}. Awaiting decision.`, "HERMES_NOTIFIED");

                        await supabase.from('strategy_config').update({ last_veto_time: new Date().toISOString() }).eq('id', config.id).eq('tenant_id', tenantId);

                        decision.statusOverride = 'HERMES_NOTIFIED';
                        decision.telemetry.oracle_reasoning = "Ping sent to Agent Cortex. Awaiting autonomous execution or veto.";
                        decision.telemetry.status_overlay = "HANDED TO AGENT";
                    }
                }

                let baseStatus = (config.trap_side && config.trap_price) ? "TRAP_ACTIVE" : "STABLE";
                const finalStatus = decision.statusOverride || (decision.signal ? "RESONANT" : baseStatus);
                
                if (scanId) {
                    await supabase.from('scan_results').update({ telemetry: decision.telemetry, status: finalStatus }).eq('id', scanId);
                } else {
                    await supabase.from('scan_results').insert([{ tenant_id: tenantId, strategy: config.strategy, asset: config.asset, telemetry: decision.telemetry, status: finalStatus }]);
                }

            } catch (e) {
                console.error(`[SNIPER-${tenantId}] ASSET ERROR ${config.asset}:`, e.message);
                await logAgentActivity(tenantId, "Sniper", config.asset, `Error during strategy evaluation for ${config.asset}: ${e.message}`, "ERROR");
            } finally {
                state.isProcessingMath[config.id] = false;
                await supabase.from('strategy_config').update({ is_processing: false }).eq('id', config.id).eq('tenant_id', tenantId);
            }
        }
    });

    ws.on('close', () => { setTimeout(() => startSniper(tenantId), 5000); });
    ws.on('error', (err) => { console.error(`[SNIPER-${tenantId}] WebSocket Error:`, err.message); });
}

async function logAgentActivity(tenant_id, agent_name, asset, log_message, log_type = 'INFO') {
    try {
        const { error } = await supabase.from('agent_session_logs').insert([
            { tenant_id, agent_name, asset, log_message, log_type, timestamp: new Date().toISOString() }
        ]);
        if (error) {
            console.error("[SNIPER LOGGING ERROR]: Failed to log agent activity:", error.message);
        }
    } catch (err) {
        console.error("[SNIPER LOGGING FATAL]: Uncaught error in logAgentActivity:", err.message);
    }
}