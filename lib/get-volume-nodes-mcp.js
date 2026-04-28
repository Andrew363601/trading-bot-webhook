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

export async function getVolumeNodesMCP(args) {
    const apiKey = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;
    const symbol = args.symbol || 'BTC-PERP';
    const tf = args.timeframe || 'ONE_HOUR';

    try {
        let product = symbol.toUpperCase().trim().replace('PERP', '-PERP');
        const end = Math.floor(Date.now() / 1000);
        let seconds = 3600;
        if (tf === 'FIFTEEN_MINUTE') seconds = 900;
        if (tf === 'FIVE_MINUTE') seconds = 300;

        const start = end - (seconds * 200); 
        const path = `/api/v3/brokerage/products/${product}/candles?start=${start}&end=${end}&granularity=${tf}`;
        
        const resp = await fetch(`https://api.coinbase.com${path}`, { 
            headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', path, apiKey, apiSecret)}` } 
        });
        
        const data = await resp.json();
        const candles = data.candles?.map(c => ({ high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume) })) || [];

        if (candles.length === 0) return { error: "No candle data available." };

        let minPrice = Infinity; 
        let maxPrice = -Infinity;
        let currentPrice = candles[0].close;

        candles.forEach(c => { 
            if (c.low < minPrice) minPrice = c.low; 
            if (c.high > maxPrice) maxPrice = c.high; 
        });

        const numBuckets = 50; 
        const bucketSize = (maxPrice - minPrice) / numBuckets;
        const volumeProfile = new Array(numBuckets).fill(0).map((_, i) => ({ price: minPrice + (i * bucketSize) + (bucketSize / 2), volume: 0 }));

        candles.forEach(c => {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            let bucketIndex = Math.floor((typicalPrice - minPrice) / bucketSize);
            if (bucketIndex >= numBuckets) bucketIndex = numBuckets - 1; 
            if (bucketIndex < 0) bucketIndex = 0;
            volumeProfile[bucketIndex].volume += c.volume;
        });

        volumeProfile.sort((a, b) => b.volume - a.volume);
        
        const highVolumeNodes = volumeProfile.slice(0, 3).map(n => parseFloat(n.price.toFixed(2)));
        const lowVolumeNodes = volumeProfile.slice(-5).map(n => parseFloat(n.price.toFixed(2))).sort((a, b) => a - b);

        return {
            symbol: product,
            timeframe: tf,
            current_price: currentPrice,
            liquidity_walls_HVN: highVolumeNodes,
            liquidity_vacuums_LVN: lowVolumeNodes
        };
    } catch (e) { return { error: `Volume Nodes Failed: ${e.message}` }; }
}