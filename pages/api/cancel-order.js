// pages/api/cancel-order.js
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { order_ids } = req.body;
    
    if (!order_ids || !Array.isArray(order_ids)) {
        return res.status(400).json({ error: "Missing order_ids array" });
    }

    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    if (!apiKeyName || !apiSecret) {
        throw new Error("Missing Coinbase API credentials.");
    }

    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
    const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
    
    const token = jwt.sign(
        { 
            iss: 'cdp', 
            nbf: Math.floor(Date.now() / 1000), 
            exp: Math.floor(Date.now() / 1000) + 120, 
            sub: apiKeyName, 
            uri: `POST api.coinbase.com${cancelPath}` 
        },
        privateKey,
        { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
    );

    const response = await fetch(`https://api.coinbase.com${cancelPath}`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ order_ids })
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error("[CANCEL FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}