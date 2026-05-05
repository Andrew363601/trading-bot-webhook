// lib/get-market-state-mcp.js
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

function generateCoinbaseToken(method, path, apiKey, apiSecret) {
    const privateKey = crypto.createPrivateKey({ key: apiSecret.replace(/\\n/g, '\n'), format: 'pem' });
    const uriPath = path.split('?')[0];
    return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
    );
}

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

async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
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
        const resp = await fetch(`https://api.coinbase.com${path}?start=${start}&end=${end}&granularity=${granularity}`, { headers: { 'Authorization': `Bearer ${token}` } });
        
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
                    fetch(`https://api.coinbase.com${bookPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', bookPath, apiKey, secret)}` } }),
                    fetch(`https://api.coinbase.com${spotPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', spotPath, apiKey, secret)}` } }),
                    fetch(`https://api.coinbase.com${futuresPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', futuresPath, apiKey, secret)}` } })
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

export async function getMarketStateMCP(args) {
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;
    const symbol = args.symbol || 'ETH-PERP';
    
    // Safely extract the dynamic trigger timeframe from arguments
    const triggerTf = args.trigger_tf || 'THIRTY_MINUTE';

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