// pages/api/cancel-order.js
import { createClient } from '@supabase/supabase-js';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { tenantId } = req.tenant;
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
        console.error(`[CANCEL] Key retrieval failed for tenant ${tenantId}: ${e.message}. No fallback keys available.`);
        return res.status(403).json({ error: 'No Coinbase API keys configured for this tenant. Please configure them in Settings.' });
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

export default withTenantAuth(handler);