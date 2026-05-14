// pages/api/portfolio.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handler(req, res) {
  try {
    const { asset } = req.query; 
    const { tenantId } = req.tenant;

    let apiKeyName = process.env.COINBASE_API_KEY;
    let apiSecret = process.env.COINBASE_API_SECRET || "";

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
        console.warn(`[PORTFOLIO] No keys for tenant ${tenantId}. Cannot fetch live portfolio.`);
        return res.status(200).json({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 }, currentPrice: 0 });
    }
    
    // 1. Clean the secret
    apiSecret = apiSecret.replace(/\\n/g, '\n');
    if (apiSecret.startsWith('"') && apiSecret.endsWith('"')) apiSecret = apiSecret.slice(1, -1);
    apiSecret = apiSecret.trim();
    
    let liveBalance = 0;
    const initialPaperFunds = 5000;
    let paperBalance = initialPaperFunds;
    let currentMarketPrice = 0;

    // Fetch LIVE Market Price
    try {
        if (asset) {
            // Try fetching via Advanced Trade API first if we have keys (more accurate for PERPs)
            if (apiKeyName && apiSecret) {
                try {
                    const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
                    const path = `/api/v3/brokerage/products/${asset}`;
                    const token = jwt.sign(
                        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `GET api.coinbase.com/api/v3/brokerage/products/${asset}` },
                        privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
                    );

                    const priceResp = await fetch(`https://api.coinbase.com${path}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });

                    if (priceResp.ok) {
                        const productData = await priceResp.json();
                        currentMarketPrice = parseFloat(productData.price || 0);
                    }
                } catch (advPriceErr) {
                    console.warn("[PRICE ADVANCED WARN]: Could not fetch price via Advanced API, falling back to public.");
                }
            }

            // Fallback to public exchange API (Spot proxy)
            if (currentMarketPrice === 0) {
                const baseCoin = asset.split('-')[0]; 
                const priceResp = await fetch(`https://api.exchange.coinbase.com/products/${baseCoin}-USD/ticker`);
                if (priceResp.ok) {
                    const priceData = await priceResp.json();
                    currentMarketPrice = parseFloat(priceData.price || 0);
                }
            }
        }
    } catch (priceErr) {
        console.warn("[PRICE PROXY WARN]: Could not fetch live price.");
    }

    // Fetch LIVE Balance from Coinbase (Spot + CFM Futures)
    try {
        if (apiKeyName && apiSecret) {
          const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });

          const generateToken = (method, path) => {
              return jwt.sign(
                { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${path}` }, 
                privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
              );
          };

          // A. Fetch Spot USD/USDC Balance
          const spotPath = '/api/v3/brokerage/accounts';
          const spotResp = await fetch(`https://api.coinbase.com${spotPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', spotPath)}` } });
          
          if (spotResp.ok) {
              const data = await spotResp.json();
              const fiatAccounts = data.accounts?.filter(a => a.currency === 'USD' || a.currency === 'USDC') || [];
              liveBalance += fiatAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance.value), 0);
          }

          // B. THE FIX: Fetch CFM (Futures) Vault Balance
          const cfmPath = '/api/v3/brokerage/cfm/balance_summary';
          const cfmResp = await fetch(`https://api.coinbase.com${cfmPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', cfmPath)}` } });
          
          if (cfmResp.ok) {
              const cfmData = await cfmResp.json();
              const cfmEquity = cfmData.balance_summary?.total_balance?.value || 
                                cfmData.balance_summary?.total_usd_balance?.value || 
                                cfmData.balance_summary?.futures_margin_balance?.value || 0;
              liveBalance += parseFloat(cfmEquity);
          }
        }
    } catch (cryptoErr) {
        console.warn(`[PORTFOLIO CRYPTO REJECT]: Likely environment restriction.`, cryptoErr.message);
    }

    const { data: paperLogs } = await supabase
      .from('trade_logs')
      .select('pnl')
      .eq('tenant_id', tenantId)
      .eq('execution_mode', 'PAPER')
      .not('pnl', 'is', null);

    if (paperLogs) {
      const totalPaperPnL = paperLogs.reduce((sum, log) => sum + parseFloat(log.pnl), 0);
      paperBalance += totalPaperPnL;
    }

    return res.status(200).json({
      live: { balance: liveBalance },
      paper: { balance: paperBalance, initial: initialPaperFunds },
      price: currentMarketPrice 
    });

  } catch (err) {
    console.error("[PORTFOLIO FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

export default withTenantAuth(handler);