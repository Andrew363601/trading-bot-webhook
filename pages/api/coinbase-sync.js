// pages/api/coinbase-sync.js
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

        // 1. Fetch Unfilled Orders (Limit Entries, TP/SL)
        const orderPath = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN';
        let orderData = { orders: [] };
        
        try {
            const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, {
                headers: { 'Authorization': `Bearer ${generateToken('GET', orderPath)}` }
            });
            
            if (orderResp.ok) {
                orderData = await orderResp.json();
            } else {
                console.warn('[SYNC WARN] Orders endpoint rejected:', await orderResp.text());
            }
        } catch (e) { console.error("Order fetch failed:", e.message); }

        // 2. Fetch Live US/CFM Positions
        const posPath = '/api/v3/brokerage/positions'; 
        let posData = { positions: [] };
        
        try {
            const posResp = await fetch(`https://api.coinbase.com${posPath}`, {
                headers: { 'Authorization': `Bearer ${generateToken('GET', posPath)}` }
            });
            
            if (posResp.ok) {
                posData = await posResp.json();
            } else {
                console.warn('[SYNC WARN] Positions endpoint rejected:', await posResp.text());
            }
        } catch (e) { console.error("Position fetch failed:", e.message); }

        // Always return 200 to the frontend so the UI doesn't crash, even if empty
        return res.status(200).json({ 
            positions: posData.positions || [], 
            orders: orderData.orders || [] 
        });

    } catch (error) {
        console.error('[SYNC FATAL]', error);
        return res.status(200).json({ positions: [], orders: [] }); // Graceful fallback
    }
}