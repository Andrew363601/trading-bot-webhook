// pages/api/coinbase-sync.js
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const apiKeyName = process.env.COINBASE_API_KEY;
        const apiSecret = process.env.COINBASE_API_SECRET;
        if (!apiKeyName || !apiSecret) return res.status(401).json({ error: 'Missing API Keys' });

        const formattedSecret = apiSecret.replace(/\\n/g, '\n').trim();
        
        let privateKey;
        try {
            // StackBlitz might throw "Unsupported" here
            privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });
        } catch (e) {
            console.warn("[SYNC CRYPTO WARN]: Private key creation unsupported in this environment.");
            return res.status(200).json({ positions: [], orders: [], warning: "Environment restriction" });
        }

        const generateToken = (method, path) => {
            const uriPath = path.split('?')[0]; 
            return jwt.sign(
                { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${uriPath}` },
                privateKey,
                { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
            );
        };

        // 1. Fetch Unfilled Orders
        const orderPath = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN';
        let orderData = { orders: [] };
        try {
            const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, {
                headers: { 'Authorization': `Bearer ${generateToken('GET', orderPath)}` }
            });
            if (orderResp.ok) orderData = await orderResp.json();
        } catch (e) { console.error("Order fetch failed:", e.message); }

        // 2. Fetch Live Positions
        const posPath = '/api/v3/brokerage/cfm/positions'; 
        let posData = { positions: [] };
        try {
            const posResp = await fetch(`https://api.coinbase.com${posPath}`, {
                headers: { 'Authorization': `Bearer ${generateToken('GET', posPath)}` }
            });
            if (posResp.ok) posData = await posResp.json();
        } catch (e) { console.error("Position fetch failed:", e.message); }

        return res.status(200).json({ 
            positions: posData.positions || [], 
            orders: orderData.orders || [] 
        });

    } catch (error) {
        console.error('[SYNC ERROR]', error.message);
        return res.status(200).json({ positions: [], orders: [] }); 
    }
}