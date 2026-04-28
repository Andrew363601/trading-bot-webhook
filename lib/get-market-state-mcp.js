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

async function fetchCoinbaseData(asset, granularity, apiKey, secret) {
    try {
        let coinbaseProduct = asset.toUpperCase().trim();
        if (!coinbaseProduct.includes('-')) {
            coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP').replace('USD', '-USD');
        }
        
        const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
        const end = Math.floor(Date.now() / 1000);
        
        // 🟢 THE FIX: Dynamic timeframe handling
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
        let cvd = 0; let macro_cvd = 0;
        
        const cvdCandles = triggerCandles.slice(-50);
        for (let i = 0; i < cvdCandles.length; i++) {
            const c = cvdCandles[i]; const range = c.high - c.low;
            let openPrice = c.open || (i > 0 ? cvdCandles[i-1].close : c.close);
            if (range > 0) cvd += c.volume * ((c.close - openPrice) / range);
        }

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

        if (apiKey && secret) {
            try {
                const bookPath = `/api/v3/brokerage/product_book?product_id=${coinbaseProduct}&limit=50`;
                const bookResp = await fetch(`https://api.coinbase.com${bookPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', bookPath, apiKey, secret)}` } });
                if (bookResp.ok) {
                    const bookJson = await bookResp.json();
                    const bids = bookJson.pricebook?.bids || []; const asks = bookJson.pricebook?.asks || [];
                    let totalBidSize = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
                    let totalAskSize = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
                    orderBookData = { 
                        bids_50_levels: parseFloat((totalBidSize || 0).toFixed(2)), 
                        asks_50_levels: parseFloat((totalAskSize || 0).toFixed(2)), 
                        imbalance: totalBidSize > totalAskSize ? "BULLISH" : "BEARISH" 
                    };
                }
                
                const productPath = `/api/v3/brokerage/products/${spotProduct}`;
                const productResp = await fetch(`https://api.coinbase.com${productPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', productPath, apiKey, secret)}` } });
                if (productResp.ok) {
                    const productJson = await productResp.json();
                    spotPrice = parseFloat(productJson.price || currentPrice);
                    basisPremium = ((currentPrice - spotPrice) / spotPrice) * 100;
                }
            } catch (err) { console.error("[Market State Fetch Error]", err.message); }
        }

        return { 
            indicators: { 
                current_cvd: parseFloat(cvd.toFixed(2)),
                macro_cvd: parseFloat(macro_cvd.toFixed(2)), 
                macro_poc: parseFloat(macro_poc.toFixed(2)),
                upper_macro_node: upper_macro_node ? parseFloat(upper_macro_node.toFixed(2)) : null,
                lower_macro_node: lower_macro_node ? parseFloat(lower_macro_node.toFixed(2)) : null
            }, 
            orderBook: orderBookData, 
            derivativesData: { spot_price: spotPrice, futures_price: currentPrice, basis_premium_percent: parseFloat(basisPremium.toFixed(4)) } 
        };
    } catch (e) { return { indicators: {}, orderBook: {}, derivativesData: {} }; }
}

// 🟢 THE FIX: Multi-Timeframe Omniscience
export async function getMarketStateMCP(args) {
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;
    const symbol = args.symbol || 'ETH-PERP';

    try {
        const [candles1H, candles15M, candles5M] = await Promise.all([
            fetchCoinbaseData(symbol, 'ONE_HOUR', apiKeyName, apiSecret),
            fetchCoinbaseData(symbol, 'FIFTEEN_MINUTE', apiKeyName, apiSecret),
            fetchCoinbaseData(symbol, 'FIVE_MINUTE', apiKeyName, apiSecret)
        ]);

        if (!candles1H || !candles15M || !candles5M) throw new Error("Failed to fetch multi-TF data.");

        const micro1H = await fetchMicrostructure(symbol, candles1H, candles1H, apiKeyName, apiSecret);
        const micro15M = await fetchMicrostructure(symbol, candles15M, candles1H, apiKeyName, apiSecret);
        const micro5M = await fetchMicrostructure(symbol, candles5M, candles1H, apiKeyName, apiSecret);

        const currentPrice = candles5M[candles5M.length - 1].close;

        return {
            symbol: symbol,
            current_price: currentPrice,
            timestamp: new Date().toISOString(),
            multi_timeframe_cvd: {
                "1H_Trend": micro1H.indicators.current_cvd,
                "15M_Flow": micro15M.indicators.current_cvd,
                "5M_Micro": micro5M.indicators.current_cvd
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