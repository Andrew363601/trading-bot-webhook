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

export async function getFractalsMCP(args) {
    const apiKey = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;
    const symbol = args.symbol || 'BTC-PERP';
    const tf = args.timeframe || 'FIVE_MINUTE';

    try {
        let product = symbol.toUpperCase().trim().replace('PERP', '-PERP');
        const end = Math.floor(Date.now() / 1000);
        let seconds = 300;
        if (tf === 'ONE_HOUR') seconds = 3600;
        if (tf === 'FIFTEEN_MINUTE') seconds = 900;

        const start = end - (seconds * 100); 
        const path = `/api/v3/brokerage/products/${product}/candles?start=${start}&end=${end}&granularity=${tf}`;
        
        const resp = await fetch(`https://api.coinbase.com${path}`, { 
            headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', path, apiKey, apiSecret)}` } 
        });
        
        const data = await resp.json();
        const candles = data.candles?.map(c => ({ high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) })).reverse() || [];

        let bullishFractals = [];
        let bearishFractals = [];
        let currentPrice = candles[candles.length - 1]?.close || 0;

        for (let i = 2; i < candles.length - 2; i++) {
            const isBullish = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                              candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
            
            const isBearish = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                              candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;

            if (isBullish) bullishFractals.push(parseFloat(candles[i].low.toFixed(2)));
            if (isBearish) bearishFractals.push(parseFloat(candles[i].high.toFixed(2)));
        }

        const validSupports = bullishFractals.filter(p => p < currentPrice).sort((a, b) => b - a);
        const validResistances = bearishFractals.filter(p => p > currentPrice).sort((a, b) => a - b);

        return {
            symbol: product,
            timeframe: tf,
            current_price: currentPrice,
            nearest_structural_support: validSupports.slice(0, 3),
            nearest_structural_resistance: validResistances.slice(0, 3)
        };
    } catch (e) { return { error: `Fractal Calculation Failed: ${e.message}` }; }
}