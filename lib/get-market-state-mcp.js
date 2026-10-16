// lib/get-market-state-mcp.js
import { cbRequest, generateCoinbaseToken } from './providers/coinbase.js';
// 🟢 AM63 (Push 6) — venue telemetry doors. KRF ids get REAL venue marks + a REAL
// book + a venue-OHLC cascade; KRX ids get marks-only with an HONEST-DARK book (the
// Bitnomial REST book does not exist — probed). The Coinbase path stays byte-identical.
import { fetchCandles } from './candles.js';
import { getKrakenTickers, resolveKrakenFuturesProduct, getKrakenOrderBook, summarizeKrakenBook } from './providers/kraken-futures.js';
import { getMarketStats, resolveKrakenProduct } from './providers/kraken-bitnomial.js';

async function fetchMacroAsset(ticker) {
    try {
        const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (resp.ok) {
            const data = await resp.json();
            const closes = data.chart.result[0].indicators.quote[0].close.filter(p => p !== null);
            return parseFloat(closes[closes.length - 1].toFixed(2));
        }
        return null;
    } catch (e) { return null; }
}

export async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
    try {
        let coinbaseProduct = asset.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) {
            coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP').replace('USD', '-USD');
        }
        
        const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
        const end = Math.floor(Date.now() / 1000);
        
        let secondsPerCandle = 3600;
        if (granularity === 'ONE_MINUTE') secondsPerCandle = 60;
        else if (granularity === 'FIVE_MINUTE') secondsPerCandle = 300;
        else if (granularity === 'FIFTEEN_MINUTE') secondsPerCandle = 900;
        else if (granularity === 'THIRTY_MINUTE') secondsPerCandle = 1800;
        else if (granularity === 'ONE_HOUR') secondsPerCandle = 3600;
        else if (granularity === 'TWO_HOUR') secondsPerCandle = 7200;
        else if (granularity === 'SIX_HOUR') secondsPerCandle = 21600;
        else if (granularity === 'ONE_DAY') secondsPerCandle = 86400;

        const start = end - (secondsPerCandle * 300); 
        
        const token = generateCoinbaseToken('GET', path, apiKey, secret);
        const resp = await cbRequest({ token: `${token}`, method: 'GET', path: `${path}?start=${start}&end=${end}&granularity=${granularity}` });
        
        if (!resp.ok) throw new Error(`Coinbase HTTP ${resp.status}`); 
        const data = await resp.json();
        
        return data.candles?.map(c => ({ 
            open: c.open ? parseFloat(c.open) : parseFloat(c.close),
            close: parseFloat(c.close), high: parseFloat(c.high), 
            low: parseFloat(c.low), volume: parseFloat(c.volume) 
        })).reverse();
    } catch (err) { throw err; } 
}

async function fetchMicrostructure(asset, triggerCandles, macroCandles, apiKey, secret) {
    try {
        let typicalPriceVolume = 0; let totalVolume = 0; let trueRanges = []; let cvd = 0; 
        let cvd_sequence = []; 
        
        const cvdCandles = triggerCandles.slice(-50);
        for (let i = 0; i < cvdCandles.length; i++) {
            const c = cvdCandles[i]; const range = c.high - c.low;
            let openPrice = c.open || (i > 0 ? cvdCandles[i-1].close : c.close);
            if (range > 0) cvd += c.volume * ((c.close - openPrice) / range);
        }

        const last5 = triggerCandles.slice(-5);
        for (let i = 0; i < last5.length; i++) {
            const c = last5[i]; const range = c.high - c.low;
            let openPrice = c.open || c.close;
            let val = range > 0 ? c.volume * ((c.close - openPrice) / range) : 0;
            cvd_sequence.push(parseFloat(val.toFixed(2)));
        }

        for (let i = 1; i < triggerCandles.length; i++) {
            const c = triggerCandles[i]; const prev = triggerCandles[i-1];
            typicalPriceVolume += ((c.high + c.low + c.close) / 3) * c.volume; totalVolume += c.volume;
            trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
        }
        const vwap = totalVolume > 0 ? typicalPriceVolume / totalVolume : triggerCandles[triggerCandles.length - 1].close;
        const atr = trueRanges.length > 0 ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : 0;

        let macro_cvd = 0;
        const macroCvdCandles = macroCandles.slice(-50);
        for (let i = 0; i < macroCvdCandles.length; i++) {
            const c = macroCvdCandles[i]; const range = c.high - c.low;
            let openPrice = c.open || (i > 0 ? macroCvdCandles[i-1].close : c.close);
            if (range > 0) macro_cvd += c.volume * ((c.close - openPrice) / range);
        }

        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        let minPrice = Infinity; let maxPrice = -Infinity;
        const pocCandles = macroCandles.slice(-150);
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
        const upper_macro_node = peaks.find(p => p.price > currentPrice)?.price || null;
        const lower_macro_node = peaks.find(p => p.price < currentPrice)?.price || null;

        let coinbaseProduct = asset.toUpperCase().trim().replace('PERP', '-PERP');
        const spotProduct = coinbaseProduct.split('-')[0] + '-USD';
        let orderBookData = { status: "Unavailable" };
        let basisPremium = 0; let spotPrice = currentPrice;
        
        // 🟢 THE UPGRADE: Native Coinbase intent variables
        let openInterest = "Unavailable"; 
        let fundingRate = "Unavailable"; 
        let annualizedFunding = "Unavailable";

        if (apiKey && secret) {
            try {
                const bookPath = `/api/v3/brokerage/product_book?product_id=${coinbaseProduct}&limit=50`;
                const spotPath = `/api/v3/brokerage/products/${spotProduct}`;
                const futuresPath = `/api/v3/brokerage/products/${coinbaseProduct}`;

                // 🟢 THE FIX: Fetch Order Book, Spot Price, AND Futures Details Concurrently
                const [bookResp, spotResp, futuresResp] = await Promise.all([
                    cbRequest({ token: `${generateCoinbaseToken('GET', bookPath, apiKey, secret)}`, method: 'GET', path: `${bookPath}` }),
                    cbRequest({ token: `${generateCoinbaseToken('GET', spotPath, apiKey, secret)}`, method: 'GET', path: `${spotPath}` }),
                    cbRequest({ token: `${generateCoinbaseToken('GET', futuresPath, apiKey, secret)}`, method: 'GET', path: `${futuresPath}` })
                ]);

                if (bookResp.ok) {
                    const bookJson = await bookResp.json();
                    const bids = bookJson.pricebook?.bids || []; 
                    const asks = bookJson.pricebook?.asks || [];
                    
                    let top5Bids = bids.slice(0, 5).reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    let deepBids = bids.slice(5).reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    let top5Asks = asks.slice(0, 5).reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
                    let deepAsks = asks.slice(5).reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

                    let largestBid = bids.length > 0 ? bids.reduce((max, b) => parseFloat(b.size) > parseFloat(max.size) ? b : max, {price: 0, size: 0}) : {price: 0, size: 0};
                    let largestAsk = asks.length > 0 ? asks.reduce((max, a) => parseFloat(a.size) > parseFloat(max.size) ? a : max, {price: 0, size: 0}) : {price: 0, size: 0};

                    orderBookData = { 
                        immediate_bids: parseFloat(top5Bids.toFixed(2)),
                        deep_bids: parseFloat(deepBids.toFixed(2)),
                        immediate_asks: parseFloat(top5Asks.toFixed(2)),
                        deep_asks: parseFloat(deepAsks.toFixed(2)),
                        largest_bid_wall: { price: parseFloat(largestBid.price), size: parseFloat(largestBid.size) },
                        largest_ask_wall: { price: parseFloat(largestAsk.price), size: parseFloat(largestAsk.size) },
                        imbalance: (top5Bids + deepBids) > (top5Asks + deepAsks) ? "BULLISH" : "BEARISH" 
                    };
                }
                
                if (spotResp.ok) {
                    const spotJson = await spotResp.json();
                    spotPrice = parseFloat(spotJson.price || currentPrice);
                    basisPremium = ((currentPrice - spotPrice) / spotPrice) * 100;
                }

                // 🟢 THE EXTRACTION: Native Coinbase OI and Funding Rates
                if (futuresResp.ok) {
                    const futuresJson = await futuresResp.json();
                    const details = futuresJson.future_product_details || futuresJson.product?.future_product_details || {};
                    if (details.open_interest) {
                        openInterest = parseFloat(details.open_interest || 0);
                        fundingRate = parseFloat(details.funding_rate || 0);
                        // Coinbase PERP funding occurs hourly. Annualizing it:
                        annualizedFunding = fundingRate * 24 * 365 * 100; 
                    }
                }
            } catch (err) { console.error("[Market State Fetch Error]", err.message); }
        }

        return { 
            indicators: { 
                current_cvd: parseFloat(cvd.toFixed(2)),
                cvd_sequence: cvd_sequence,
                macro_cvd: parseFloat(macro_cvd.toFixed(2)), 
                macro_poc: parseFloat(macro_poc.toFixed(2)),
                upper_macro_node: upper_macro_node ? parseFloat(upper_macro_node.toFixed(2)) : null,
                lower_macro_node: lower_macro_node ? parseFloat(lower_macro_node.toFixed(2)) : null,
                current_atr: parseFloat(atr.toFixed(2))
            }, 
            orderBook: orderBookData, 
            derivativesData: { 
                spot_price: spotPrice, 
                futures_price: currentPrice, 
                basis_premium_percent: parseFloat(basisPremium.toFixed(4)),
                open_interest: openInterest,
                funding_rate: fundingRate,
                annualized_funding_percent: annualizedFunding !== "Unavailable" ? parseFloat(annualizedFunding.toFixed(2)) : "Unavailable"
            } 
        };
    } catch (e) { return { indicators: {}, orderBook: {}, derivativesData: {} }; }
}

// ── 🟢 AM63 (Push 6) — VENUE PARITY MAP (the brain's prompts depend on these names) ──
// get_market_state for a KRF id returns the SAME top-level shape as the Coinbase
// path above. Field-by-field:
//   symbol                     → the venue id echoed unchanged (XRP-PERP-KRF)
//   current_price              → last 5M VENUE-candle close (same semantics)
//   timestamp                  → unchanged
//   cross_asset_macro          → unchanged (Yahoo SP500/DXY — venue-agnostic)
//   multi_timeframe_cvd.*      → SAME CVD math on VENUE candles. The 6H tier rides
//                                4H (Kraken charts 400 on 6h — probe-pinned) and the
//                                substitution is declared in cascade_note. The trigger
//                                TF is NEVER substituted — an unsupported TF is a loud
//                                error, never a silent different-TF read.
//   volatility_atr.*           → SAME ATR math on venue candles
//   volume_profile.*           → SAME profile math on venue 1H candles
//   order_book_depth           → REAL Kraken book in THIS tool's shape:
//                                immediate_bids/deep_bids/immediate_asks/deep_asks
//                                (top-5-level size sum / remaining sum — mirrors the
//                                Coinbase top5/deep split), largest_bid_wall /
//                                largest_ask_wall (SINGULAR — top-by-size each side),
//                                imbalance BULLISH|BEARISH (same rule as Coinbase).
//   derivatives_premium        → spot_price = ticker indexPrice (fallback mark),
//                                futures_price = markPrice, basis_premium_percent =
//                                (mark − index)/index × 100 ("0.0000" when index is
//                                absent), open_interest = ticker openInterest,
//                                funding_rate = raw relativeFundingRate (Kraken Futures
//                                funding is hourly), annualized_funding_percent =
//                                fundingRate × 24 × 365 × 100 (the SAME formula the
//                                Coinbase path uses — correct for hourly funding).
//   venue (additive)           → 'krakenfutures'
//   cascade_note (additive)    → present only when the 6H tier rode a lower TF.
// KRX (Bitnomial) is MARKS-ONLY: the REST book does NOT exist (probed — 404s), so
// order_book_depth is the tool's honest-unavailable shape with the pinned reason —
// NEVER a fabricated zero-walls "valid" read. Candle-derived fields are "Unavailable"
// (no venue OHLC until the market-data push) — deriveRegime then degrades to CHOP,
// which is the correct conservative read for a blind entry.

// Coinbase granularity name → seconds (the venue branch's TF vocabulary).
const VENUE_TF_SECONDS = {
    'ONE_MINUTE': 60,
    'FIVE_MINUTE': 300,
    'FIFTEEN_MINUTE': 900,
    'THIRTY_MINUTE': 1800,
    'ONE_HOUR': 3600,
    'FOUR_HOUR': 14400,
    'TWO_HOUR': 7200,
    'SIX_HOUR': 21600,
    'ONE_DAY': 86400,
};

/**
 * KRF branch: REAL venue telemetry for a `${BASE}-PERP-KRF` id.
 * Reuses fetchMicrostructure for ALL candle math (CVD/ATR/profile) by passing null
 * keys — it skips every Coinbase fetch when keys are falsy — then overwrites
 * order_book_depth + derivatives_premium with REAL venue data.
 */
async function getKrakenFuturesMarketState(symbol, args) {
    try {
        const product = await resolveKrakenFuturesProduct(symbol);
        if (product?.error) return { error: product.error };

        const triggerTf = args.trigger_tf || 'FIVE_MINUTE';
        const end = Math.floor(Date.now() / 1000);
        const fetchVenueTf = async (tfName) => {
            const seconds = VENUE_TF_SECONDS[tfName];
            if (!seconds) throw new Error(`Unsupported timeframe ${tfName} for ${symbol} (venue OHLC). Never fall back to a different timeframe — re-check trigger_tf/granularity.`);
            const candles = await fetchCandles({ product: symbol, granularitySeconds: seconds, startEpoch: end - seconds * 300, endEpoch: end });
            if (!candles || candles.length === 0) throw new Error(`Failed to fetch ${tfName} candles for ${symbol} from the venue. Never fall back to a different timeframe — re-check symbol/granularity.`);
            return candles;
        };

        // 4-Tier Cascade on VENUE OHLC. Kraken charts 400 on 6h → the 6H macro-tide
        // tier rides 4H (14400s) and the substitution is DECLARED in cascade_note
        // (house precedent: the ATR tool's 30M→1H floored retry).
        let cascadeNote = null;
        let candles6H;
        try {
            candles6H = await fetchVenueTf('SIX_HOUR');
        } catch (e) {
            candles6H = await fetchVenueTf('FOUR_HOUR');
            cascadeNote = '6H tier rode 4H (source TF 6H unsupported by the venue)';
        }
        const [candles1H, candlesTrigger, candles5M, sp500, dxy] = await Promise.all([
            fetchVenueTf('ONE_HOUR'),
            fetchVenueTf(triggerTf),
            fetchVenueTf('FIVE_MINUTE'),
            fetchMacroAsset('%5EGSPC'),
            fetchMacroAsset('DX-Y.NYB'),
        ]);

        if (!candles6H || !candles1H || !candlesTrigger || !candles5M) throw new Error("Failed to fetch multi-TF data.");

        const micro6H = await fetchMicrostructure(symbol, candles6H, candles6H, null, null);
        const micro1H = await fetchMicrostructure(symbol, candles1H, candles6H, null, null);
        const microTrigger = await fetchMicrostructure(symbol, candlesTrigger, candles1H, null, null);
        const micro5M = await fetchMicrostructure(symbol, candles5M, candles1H, null, null);

        const currentPrice = candles5M[candles5M.length - 1].close;

        // REAL book → THIS tool's SINGULAR-wall shape (parity with the Coinbase path).
        let orderBookData = { status: "Unavailable" };
        try {
            const bookResp = await getKrakenOrderBook({ nativeSymbol: product.nativeSymbol });
            if (bookResp.ok) {
                const bookJson = await bookResp.json();
                const summary = summarizeKrakenBook(bookJson?.orderBook || {}, { topN: 5, levelsN: 50 });
                const bidLevels = (bookJson?.orderBook?.bids || []).map(l => ({ price: parseFloat(l?.[0]), size: parseFloat(l?.[1]) })).filter(l => Number.isFinite(l.price) && Number.isFinite(l.size));
                const askLevels = (bookJson?.orderBook?.asks || []).map(l => ({ price: parseFloat(l?.[0]), size: parseFloat(l?.[1]) })).filter(l => Number.isFinite(l.price) && Number.isFinite(l.size));
                const top5Bids = bidLevels.slice(0, 5).reduce((s, l) => s + l.size, 0);
                const deepBids = bidLevels.slice(5).reduce((s, l) => s + l.size, 0);
                const top5Asks = askLevels.slice(0, 5).reduce((s, l) => s + l.size, 0);
                const deepAsks = askLevels.slice(5).reduce((s, l) => s + l.size, 0);
                const largestBid = bidLevels.reduce((max, l) => l.size > max.size ? l : max, { price: 0, size: 0 });
                const largestAsk = askLevels.reduce((max, l) => l.size > max.size ? l : max, { price: 0, size: 0 });
                orderBookData = {
                    immediate_bids: parseFloat(top5Bids.toFixed(2)),
                    deep_bids: parseFloat(deepBids.toFixed(2)),
                    immediate_asks: parseFloat(top5Asks.toFixed(2)),
                    deep_asks: parseFloat(deepAsks.toFixed(2)),
                    largest_bid_wall: { price: largestBid.price, size: largestBid.size },
                    largest_ask_wall: { price: largestAsk.price, size: largestAsk.size },
                    imbalance: (top5Bids + deepBids) > (top5Asks + deepAsks) ? "BULLISH" : "BEARISH"
                };
            }
        } catch (e) {
            console.error(`[AM63] KRF book fetch failed for ${symbol}: ${e.message}`);
        }

        // REAL venue marks → derivatives_premium (parity map above).
        const tickers = await getKrakenTickers({ symbols: [product.nativeSymbol] });
        const row = tickers ? tickers[product.nativeSymbol] : null;
        const markPrice = row ? parseFloat(row.markPrice ?? row.last) : null;
        const indexPrice = row && row.indexPrice != null ? parseFloat(row.indexPrice) : null;
        const fundingRate = row && row.fundingRate != null ? parseFloat(row.fundingRate) : null;
        const openInterest = row && row.openInterest != null ? parseFloat(row.openInterest) : null;
        const derivativesData = {
            spot_price: indexPrice != null && Number.isFinite(indexPrice) ? indexPrice : (Number.isFinite(markPrice) ? markPrice : currentPrice),
            futures_price: Number.isFinite(markPrice) ? markPrice : currentPrice,
            basis_premium_percent: indexPrice != null && Number.isFinite(indexPrice) && Number.isFinite(markPrice) && indexPrice > 0
                ? parseFloat((((markPrice - indexPrice) / indexPrice) * 100).toFixed(4))
                : "0.0000",
            open_interest: openInterest != null && Number.isFinite(openInterest) ? openInterest : "Unavailable",
            funding_rate: fundingRate != null && Number.isFinite(fundingRate) ? fundingRate : "Unavailable",
            annualized_funding_percent: fundingRate != null && Number.isFinite(fundingRate) ? parseFloat((fundingRate * 24 * 365 * 100).toFixed(2)) : "Unavailable"
        };

        const result = {
            symbol: symbol,
            current_price: currentPrice,
            timestamp: new Date().toISOString(),
            cross_asset_macro: {
                "SP500": sp500 || "Unavailable",
                "DXY": dxy || "Unavailable"
            },
            multi_timeframe_cvd: {
                "6H_Macro_Tide": micro6H.indicators.current_cvd,
                "1H_Macro_Trend": micro1H.indicators.current_cvd,
                "Trigger_Flow": microTrigger.indicators.current_cvd,
                "5M_Micro_Ripple": micro5M.indicators.current_cvd,
                "5M_Sequence": micro5M.indicators.cvd_sequence
            },
            volatility_atr: {
                "1H": micro1H.indicators.current_atr,
                "Trigger": microTrigger.indicators.current_atr,
                "5M": micro5M.indicators.current_atr
            },
            volume_profile: {
                macro_poc: micro1H.indicators.macro_poc,
                upper_node: micro1H.indicators.upper_macro_node,
                lower_node: micro1H.indicators.lower_macro_node
            },
            order_book_depth: orderBookData,
            derivatives_premium: derivativesData,
            venue: 'krakenfutures'
        };
        if (cascadeNote) result.cascade_note = cascadeNote;
        return result;
    } catch (error) {
        console.error(`[MCP MARKET STATE FAULT] (krakenfutures ${symbol}):`, error.message);
        return { error: error.message };
    }
}

/**
 * KRX (Bitnomial) branch: MARKS-ONLY. The REST book does NOT exist (probed — 404s);
 * walls arrive with the market-data push (WS book). Candle-derived fields are
 * "Unavailable" — no venue OHLC until the market-data push. NEVER a fabricated
 * zero-walls "valid" read.
 */
async function getBitnomialMarketState(symbol, args) {
    try {
        const product = await resolveKrakenProduct(symbol);
        if (product?.error) return { error: product.error };

        const stats = await getMarketStats({ productIds: [product.productId] });
        const row = stats ? stats[product.productId] : null;
        const mark = row ? parseFloat(row.mark_price ?? row.last_price) : null;
        if (!Number.isFinite(mark) || mark <= 0) {
            return { error: `[AM63] Bitnomial marks unavailable for ${symbol} (stats fetch failed or no row)` };
        }

        return {
            symbol: symbol,
            current_price: mark,
            timestamp: new Date().toISOString(),
            cross_asset_macro: { "SP500": "Unavailable", "DXY": "Unavailable" },
            multi_timeframe_cvd: {
                "6H_Macro_Tide": "Unavailable",
                "1H_Macro_Trend": "Unavailable",
                "Trigger_Flow": "Unavailable",
                "5M_Micro_Ripple": "Unavailable",
                "5M_Sequence": []
            },
            volatility_atr: { "1H": "Unavailable", "Trigger": "Unavailable", "5M": "Unavailable" },
            volume_profile: { macro_poc: "Unavailable", upper_node: "Unavailable", lower_node: "Unavailable" },
            order_book_depth: { status: "Unavailable", reason: "Bitnomial book arrives with the market-data push" },
            derivatives_premium: {
                spot_price: "Unavailable",
                futures_price: mark,
                basis_premium_percent: "0.0000",
                open_interest: "Unavailable",
                funding_rate: "Unavailable",
                annualized_funding_percent: "Unavailable"
            },
            venue: 'kraken'
        };
    } catch (error) {
        console.error(`[MCP MARKET STATE FAULT] (kraken ${symbol}):`, error.message);
        return { error: error.message };
    }
}

export async function getMarketStateMCP(args) {
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;
    const symbol = args.symbol || 'ETH-PERP';

    // 🟢 AM63 (Push 6) — VENUE BRANCHES run BEFORE any Coinbase fetch. The brain's
    // prompts depend on the EXACT output shape below, so every branch returns the
    // SAME top-level keys (see the PARITY MAP comment above fetchMicrostructure).
    const sym = String(symbol).toUpperCase().trim();
    if (sym.includes('-PERP-KRF')) {
        return getKrakenFuturesMarketState(sym, args);
    }
    if (sym.includes('-PERP-KRX-')) {
        return getBitnomialMarketState(sym, args);
    }

    // Safely extract the dynamic trigger timeframe from arguments
    // 🟢 TF CANON (Phase 0.11): system-wide 5M trigger default. Callers omitting
    // trigger_tf previously got 30M — silently diverging Trigger_Flow / ATR.Trigger
    // from the sniper's 5M canon for the same asset/session.
    const triggerTf = args.trigger_tf || 'FIVE_MINUTE';

    try {
        // 4-Tier Cascade Fetch (6H, 1H, Trigger, 5M)
        const [candles6H, candles1H, candlesTrigger, candles5M, sp500, dxy] = await Promise.all([
            fetchCoinbaseData(symbol, 'SIX_HOUR', apiKeyName, apiSecret),
            fetchCoinbaseData(symbol, 'ONE_HOUR', apiKeyName, apiSecret),
            fetchCoinbaseData(symbol, triggerTf, apiKeyName, apiSecret),
            fetchCoinbaseData(symbol, 'FIVE_MINUTE', apiKeyName, apiSecret),
            fetchMacroAsset('%5EGSPC'), 
            fetchMacroAsset('DX-Y.NYB') 
        ]);

        if (!candles6H || !candles1H || !candlesTrigger || !candles5M) throw new Error("Failed to fetch multi-TF data.");

        const micro6H = await fetchMicrostructure(symbol, candles6H, candles6H, apiKeyName, apiSecret);
        const micro1H = await fetchMicrostructure(symbol, candles1H, candles6H, apiKeyName, apiSecret);
        const microTrigger = await fetchMicrostructure(symbol, candlesTrigger, candles1H, apiKeyName, apiSecret);
        const micro5M = await fetchMicrostructure(symbol, candles5M, candles1H, apiKeyName, apiSecret);

        const currentPrice = candles5M[candles5M.length - 1].close;

        return {
            symbol: symbol,
            current_price: currentPrice,
            timestamp: new Date().toISOString(),
            cross_asset_macro: {
                "SP500": sp500 || "Unavailable",
                "DXY": dxy || "Unavailable"
            },
            multi_timeframe_cvd: {
                "6H_Macro_Tide": micro6H.indicators.current_cvd,
                "1H_Macro_Trend": micro1H.indicators.current_cvd,
                "Trigger_Flow": microTrigger.indicators.current_cvd, // The 30M or 15M DB anchor
                "5M_Micro_Ripple": micro5M.indicators.current_cvd,
                "5M_Sequence": micro5M.indicators.cvd_sequence 
            },
            volatility_atr: { 
                "1H": micro1H.indicators.current_atr,
                "Trigger": microTrigger.indicators.current_atr,
                "5M": micro5M.indicators.current_atr
            },
            volume_profile: {
                macro_poc: micro1H.indicators.macro_poc,
                upper_node: micro1H.indicators.upper_macro_node,
                lower_node: micro1H.indicators.lower_macro_node
            },
            order_book_depth: micro5M.orderBook,
            derivatives_premium: micro5M.derivativesData
        };

    } catch (error) {
        console.error(`[MCP MARKET STATE FAULT]:`, error.message);
        return { error: error.message };
    }
}