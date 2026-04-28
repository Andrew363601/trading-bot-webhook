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

export async function getFibonacciLevelsMCP(args) {
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
        if (tf === 'FOUR_HOUR') seconds = 14400;

        const start = end - (seconds * 150); 
        const path = `/api/v3/brokerage/products/${product}/candles?start=${start}&end=${end}&granularity=${tf}`;
        
        const resp = await fetch(`https://api.coinbase.com${path}`, { 
            headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', path, apiKey, apiSecret)}` } 
        });
        
        const data = await resp.json();
        const candles = data.candles || [];

        let high = -Infinity;
        let low = Infinity;
        let currentPrice = parseFloat(candles[0]?.close || 0);

        candles.forEach(c => {
            if (parseFloat(c.high) > high) high = parseFloat(c.high);
            if (parseFloat(c.low) < low) low = parseFloat(c.low);
        });

        const diff = high - low;
        
        return {
            symbol: product,
            timeframe: tf,
            current_price: currentPrice,
            swing_high: high,
            swing_low: low,
            fibonacci_levels: {
                "0.236": parseFloat((low + (diff * 0.236)).toFixed(2)),
                "0.382": parseFloat((low + (diff * 0.382)).toFixed(2)),
                "0.500": parseFloat((low + (diff * 0.5)).toFixed(2)),
                "0.618_Golden_Pocket": parseFloat((low + (diff * 0.618)).toFixed(2)),
                "0.786": parseFloat((low + (diff * 0.786)).toFixed(2))
            }
        };
    } catch (e) { return { error: `Fibonacci Math Failed: ${e.message}` }; }
}