// pages/api/available-assets.js force push
import { jwtVerify, createRemoteJWKSet } from 'jose';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error("[AVAILABLE ASSETS ERROR]: Missing or invalid Authorization header.");
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let tenantId = null;
  try {
    const token = authHeader.split(' ')[1];
    const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
    
    const { data: tenantData } = await supabase
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', payload.sub)
      .single();
    
    tenantId = tenantData?.tenant_id;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', details: err.message });
  }

  // ... (rest of your API route code from the previous interaction remains here)
  try {
    // Top 15 Perpetual Futures assets (Hardcoded fallback for speed)
    const topAssets = [
      'BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX', 'DOGE-PERP-INTX',
      'LINK-PERP-INTX', 'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX',
      'XRP-PERP-INTX', 'ADA-PERP-INTX', 'DOT-PERP-INTX', 'MATIC-PERP-INTX',
      'UNI-PERP-INTX', 'SHIB-PERP-INTX', 'NEAR-PERP-INTX'
    ];

    let futuresProducts = [];
    try {
      // 1. Fetch unauthenticated PERP-INTX products
      try {
        const response = await fetch('https://api.exchange.coinbase.com/products', {
          headers: { 'User-Agent': 'Nexus-Terminal' },
          next: { revalidate: 3600 } // Cache for 1 hour
        });

        if (response.ok) {
          const allProducts = await response.json();
          futuresProducts = allProducts
            .filter(p => 
              (p.product_type === 'PERPETUAL_FUTURES' || p.id.includes('PERP')) && 
              !p.trading_disabled
            )
            .map(p => ({
              id: p.id,
              name: p.id,
              base: p.base_currency,
              price: parseFloat(p.price) || 0,
              volume_24h: parseFloat(p.volume_24h) || 0,
              price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0
            }));
        }
      } catch (publicErr) {
        console.error("[AVAILABLE ASSETS WARN]: Public product fetch failed:", publicErr.message);
      }

      // 2. Fetch authenticated US Regulated Futures (CFM -CDE)
      let apiKeyName = process.env.COINBASE_API_KEY;
      let apiSecret = process.env.COINBASE_API_SECRET || "";

      if (tenantId) {
        try {
          const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
          if (secrets && secrets.apiKey && secrets.apiSecret) {
            apiKeyName = secrets.apiKey;
            apiSecret = secrets.apiSecret;
          }
        } catch (e) {
          console.log("[AVAILABLE ASSETS WARN]: Could not load tenant API key for CFM fetch. Falling back to global.");
        }
      }

      apiSecret = apiSecret.replace(/\\n/g, '\n');
      if (apiSecret.startsWith('"') && apiSecret.endsWith('"')) apiSecret = apiSecret.slice(1, -1);
      
      if (apiKeyName && apiSecret) {
        let privateKey;
        try {
          privateKey = crypto.createPrivateKey({ key: apiSecret.trim(), format: 'pem' });
        } catch (cryptoErr) {
          console.error("[AVAILABLE ASSETS ERROR]: Failed to parse private key (CFM fetch will be skipped):", cryptoErr.message);
        }
        
        if (privateKey) {
          // Fetch both FUTURE and PERPETUAL_FUTURES for better coverage and pricing
          const productTypes = ['FUTURE', 'PERPETUAL_FUTURE'];
          
          for (const type of productTypes) {
            try {
              const path = `/api/v3/brokerage/products?product_type=${type}`;
              const uriPath = path.split('?')[0];
              const cbToken = jwt.sign(
                  { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `GET api.coinbase.com${uriPath}` },
                  privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
              );

              const cfmResponse = await fetch(`https://api.coinbase.com${path}`, {
                headers: { 'Authorization': `Bearer ${cbToken}` }
              });

              if (cfmResponse.ok) {
                const cfmData = await cfmResponse.json();
                const cfmProducts = (cfmData.products || [])
                  .filter(p => !p.trading_disabled && p.product_id)
                  .map(p => ({
                    id: p.product_id,
                    name: p.product_id,
                    base: p.base_currency_id,
                    price: parseFloat(p.price) || 0,
                    volume_24h: parseFloat(p.volume_24h) || 0,
                    price_percentage_change_24h: parseFloat(p.price_percentage_change_24h) || 0
                  }));
                
                // Merge and deduplicate
                cfmProducts.forEach(newP => {
                  const existingIdx = futuresProducts.findIndex(p => p.id === newP.id);
                  if (existingIdx >= 0) {
                    // Update with better data from authenticated API if price was 0
                    if (futuresProducts[existingIdx].price === 0) {
                      futuresProducts[existingIdx] = newP;
                    }
                  } else {
                    futuresProducts.push(newP);
                  }
                });
                console.log(`[AVAILABLE ASSETS INFO]: Fetched ${cfmProducts.length} ${type} products via Advanced Trade API.`);
              }
            } catch (innerErr) {
              console.error(`[AVAILABLE ASSETS ERROR]: Failed to fetch ${type} products:`, innerErr.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('[AVAILABLE ASSETS ERROR]: Coinbase fetch exception:', e.message);
    }

    // Combine and deduplicate
    const combined = [...futuresProducts];
    topAssets.forEach(id => {
      if (!combined.find(p => p.id === id)) {
        combined.push({ id, name: id, base: id.split('-')[0], price: 0, volume_24h: 0, price_percentage_change_24h: 0 });
      }
    });

    const finalSelection = combined
      .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
      .slice(0, 100);

    return res.status(200).json({
      count: finalSelection.length,
      products: finalSelection
    });
  } catch (error) {
    console.error('[AVAILABLE ASSETS FATAL ERROR]: Uncaught error in available-assets API:', error.message);
    return res.status(500).json({ error: error.message });
  }
}