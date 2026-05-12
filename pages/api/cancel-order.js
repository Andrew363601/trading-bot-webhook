// pages/api/cancel-order.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // 1. Session Validation
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization' });
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const tenantId = user.user_metadata?.tenant_id || user.id;

    const { order_ids } = req.body;
    
    if (!order_ids || !Array.isArray(order_ids)) {
        return res.status(400).json({ error: "Missing order_ids array" });
    }

    // 2. Retrieve Tenant Specific Keys
    let apiKeyName, apiSecret;
    try {
        const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
        apiKeyName = secrets.apiKey;
        apiSecret = secrets.apiSecret?.replace(/\\n/g, '\n');
    } catch (e) {
        console.error(`[CANCEL] No keys for tenant ${tenantId}, falling back to ENV`);
        apiKeyName = process.env.COINBASE_API_KEY;
        apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');
    }

    if (!apiKeyName || !apiSecret) {
        throw new Error("Missing Coinbase API credentials.");
    }

    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
    const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
    
    const coinbaseToken = jwt.sign(
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
            'Authorization': `Bearer ${coinbaseToken}`, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ order_ids })
    });

    const data = await response.json();
    console.log(`[CANCEL-ORDER API] Orders canceled for tenant ${tenantId}:`, order_ids);
    
    return res.status(200).json(data);

  } catch (err) {
    console.error("[CANCEL FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}