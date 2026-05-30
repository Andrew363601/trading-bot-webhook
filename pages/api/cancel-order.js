// pages/api/cancel-order.js
import { createClient } from '@supabase/supabase-js';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: sign a Coinbase Advanced Trade API request.
function signCoinbase(method, path, apiKey, apiSecret) {
  const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
  const uriPath = path.split('?')[0];
  return jwt.sign(
    { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
    privateKey,
    { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
  );
}

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

    // 🛡️ PHASE J: SERVER-SIDE BRACKET GUARD.
    // Inspect each requested order. If it's a protective trigger_bracket_gtc AND
    // there's an active position for the same product, REFUSE to cancel — the
    // caller should use /api/close-position which goes through executeTradeMCP
    // (with reduce_only, reconcile, verify, restore). This prevents the UI or
    // any rogue caller from orphaning a live position.
    try {
      const protectedIds = [];
      for (const oid of order_ids) {
        if (!oid) continue;
        const lookupPath = `/api/v3/brokerage/orders/historical/${oid}`;
        const lookupResp = await fetch(`https://api.coinbase.com${lookupPath}`, {
          headers: { 'Authorization': `Bearer ${signCoinbase('GET', lookupPath, apiKeyName, apiSecret)}` }
        });
        if (!lookupResp.ok) continue; // can't classify → fall through to default behavior
        const lookupData = await lookupResp.json();
        const order = lookupData.order;
        if (!order) continue;

        const isBracket = !!order.order_configuration?.trigger_bracket_gtc;
        const isOpen = (order.status || '').toUpperCase() === 'OPEN';
        if (!isBracket || !isOpen) continue;

        // Check the position for the same product.
        const productId = order.product_id;
        if (!productId) continue;
        const posPath = '/api/v3/brokerage/cfm/positions';
        const posResp = await fetch(`https://api.coinbase.com${posPath}`, {
          headers: { 'Authorization': `Bearer ${signCoinbase('GET', posPath, apiKeyName, apiSecret)}` }
        });
        if (posResp.ok) {
          const posData = await posResp.json();
          const livePos = posData.positions?.find(p => p.product_id === productId);
          const liveQty = livePos ? Math.abs(parseFloat(livePos.number_of_contracts)) : 0;
          if (liveQty > 0) {
            protectedIds.push({ order_id: oid, product_id: productId, contracts: liveQty });
          }
        }
      }

      if (protectedIds.length > 0) {
        console.warn(`[CANCEL GUARD] Refusing to cancel ${protectedIds.length} bracket(s) protecting live position(s) for tenant ${tenantId}:`, protectedIds);
        return res.status(409).json({
          error: 'Refusing to cancel protective brackets on live positions. Use /api/close-position to flatten the position safely.',
          protected: protectedIds
        });
      }
    } catch (guardErr) {
      // Defensive: if the guard itself fails, do NOT silently fall through to the cancel.
      // Surface the error so the operator/UI is aware.
      console.error('[CANCEL GUARD] Lookup failed:', guardErr.message);
      return res.status(502).json({ error: `Bracket safety guard failed to verify orders: ${guardErr.message}. Cancel not attempted.` });
    }

    const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
    const coinbaseToken = signCoinbase('POST', cancelPath, apiKeyName, apiSecret);

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