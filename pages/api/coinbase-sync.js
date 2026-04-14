import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const apiKeyName = process.env.COINBASE_API_KEY;
        const apiSecret = process.env.COINBASE_API_SECRET;
        if (!apiKeyName || !apiSecret) return res.status(401).json({ error: 'Missing API Keys' });

        const formattedSecret = apiSecret.replace(/\\n/g, '\n');
        const privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });

        const generateToken = (method, path) => {
            return jwt.sign(
                { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${path}` },
                privateKey,
                { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
            );
        };

        // 1. Fetch Live Futures Positions
        const posPath = '/api/v3/brokerage/intl/positions'; // Coinbase Derivatives Endpoint
        const posResp = await fetch(`https://api.coinbase.com${posPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', posPath)}` }
        });
        const posData = await posResp.json();

        // 2. Fetch Unfilled Orders (Limit Entries, TP/SL)
        const orderPath = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN';
        const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', orderPath)}` }
        });
        const orderData = await orderResp.json();

        return res.status(200).json({ 
            positions: posData.positions || [], 
            orders: orderData.orders || [] 
        });

    } catch (error) {
        console.error('[SYNC FAULT]', error);
        return res.status(500).json({ error: 'Failed to sync with Coinbase' });
    }
}