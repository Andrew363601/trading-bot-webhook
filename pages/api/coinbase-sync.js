// pages/api/coinbase-sync.js
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { tenantId } = req.tenant;

        let apiKeyName = process.env.COINBASE_API_KEY;
        let apiSecret = process.env.COINBASE_API_SECRET;
        
        // Attempt to retrieve tenant-specific keys
        try {
            const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
            if (secrets && secrets.apiKey && secrets.apiSecret) {
                apiKeyName = secrets.apiKey;
                apiSecret = secrets.apiSecret;
            } else {
                throw new Error('No tenant-specific keys found');
            }
        } catch (e) {
            console.warn(`[COINBASE SYNC] No keys for tenant ${tenantId}. Cannot sync.`);
            return res.status(200).json({ positions: [], orders: [], warning: "No API keys configured for this tenant" });
        }

        if (!apiKeyName || !apiSecret) return res.status(401).json({ error: 'Missing API Keys' });

        const formattedSecret = apiSecret.replace(/\\n/g, '\n').trim();
        
        let privateKey;
        try {
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
            
            if (posResp.ok) {
                const rawData = await posResp.json();
                
                // Normalize positions and enrich with TP/SL from open orders
                posData.positions = (rawData.positions || []).map(p => {
                    const productId = p.product_id;
                    let tpPrice = null;
                    let slPrice = null;

                    // Match TP/SL orders to this position by product_id and side
                    (orderData.orders || []).forEach(order => {
                        if (order.product_id !== productId) return;
                        const config = order.order_configuration || {};
                        
                        // Stop-limit orders = Stop Loss
                        if (config.stop_limit_stop_limit_gtc) {
                            const stopPrice = parseFloat(config.stop_limit_stop_limit_gtc.stop_price);
                            if (!isNaN(stopPrice)) slPrice = stopPrice;
                        }
                        
                        // Limit orders on opposite side = Take Profit
                        if (config.limit_limit_gtc) {
                            const limitPrice = parseFloat(config.limit_limit_gtc.limit_price);
                            if (!isNaN(limitPrice) && order.side !== p.side) {
                                tpPrice = limitPrice;
                            }
                        }
                    });

                    return {
                        ...p,
                        entry_price: p.average_entry_price || p.vwap || 0,
                        size: p.number_of_contracts || p.size || 0,
                        tp_price: tpPrice,
                        sl_price: slPrice
                    };
                });
            }
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

export default withTenantAuth(handler);