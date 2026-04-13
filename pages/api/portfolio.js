// pages/api/portfolio.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const { asset } = req.query; 
    const apiKeyName = process.env.COINBASE_API_KEY;
    
    // --- THE BULLETPROOF PEM FORMATTER ---
    let apiSecret = process.env.COINBASE_API_SECRET || "";
    // 1. Violently strip any leading or trailing quotation marks Next.js might have absorbed
    apiSecret = apiSecret.replace(/^["']|["']$/g, '');
    // 2. Convert literal \n text characters into actual structural line breaks
    apiSecret = apiSecret.replace(/\\n/g, '\n');
    
    let liveBalance = 0;
    const initialPaperFunds = 5000;
    let paperBalance = initialPaperFunds;
    let currentMarketPrice = 0;

    // 1. Fetch LIVE Market Price (Using Coinbase Public API to bypass US IP bans)
    try {
        if (asset) {
            const baseCoin = asset.split('-')[0]; 
            const priceResp = await fetch(`https://api.exchange.coinbase.com/products/${baseCoin}-USD/ticker`);
            
            if (priceResp.ok) {
                const priceData = await priceResp.json();
                currentMarketPrice = parseFloat(priceData.price || 0);
            } else {
                console.warn(`[PRICE PROXY WARN]: Coinbase returned status ${priceResp.status}`);
            }
        }
    } catch (priceErr) {
        console.warn("[PRICE PROXY WARN]: Could not fetch live price.", priceErr.message);
    }

    // 2. Fetch LIVE Balance from Coinbase
    try {
        if (apiKeyName && apiSecret) {
          const path = '/api/v3/brokerage/accounts';
          
          const token = jwt.sign({
            iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
            sub: apiKeyName, uri: `GET api.coinbase.com${path}`,
          }, apiSecret, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

          const resp = await fetch(`https://api.coinbase.com${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
          
          if (resp.ok) {
              const data = await resp.json();
              const fiatAccounts = data.accounts?.filter(a => a.currency === 'USD' || a.currency === 'USDC') || [];
              liveBalance = fiatAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance.value), 0);
          } else {
              const errData = await resp.text();
              console.warn("[COINBASE BALANCE ERR]:", errData);
          }
        }
    } catch (cryptoErr) {
        // If it STILL fails, it will at least log the very first few characters so you can see the corruption
        console.warn(`[PORTFOLIO CRYPTO WARN]: Failed to parse Coinbase API Secret. Starts with: ${apiSecret.substring(0, 10)}...`);
    }

    // 3. Fetch PAPER Balance from Database
    const { data: paperLogs } = await supabase
      .from('trade_logs')
      .select('pnl')
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