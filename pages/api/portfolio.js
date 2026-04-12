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
    const { asset } = req.query; // NEW: Receives the active asset from the UI
    const apiKeyName = process.env.COINBASE_API_KEY;
    const rawSecret = process.env.COINBASE_API_SECRET;
    
    let liveBalance = 0;
    const initialPaperFunds = 5000;
    let paperBalance = initialPaperFunds;
    let currentMarketPrice = 0;

    // 1. Fetch LIVE Market Price (Server-side bypasses browser CORS entirely!)
    try {
        if (asset) {
            const binanceSymbol = `${asset.split('-')[0]}USDT`;
            // Using the ultra-stable Binance Spot API purely for UI PnL math
            const priceResp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`);
            if (priceResp.ok) {
                const priceData = await priceResp.json();
                currentMarketPrice = parseFloat(priceData.price || 0);
            }
        }
    } catch (priceErr) {
        console.warn("[PRICE PROXY WARN]: Could not fetch live price.");
    }

    // 2. Fetch LIVE Balance from Coinbase
    try {
        if (apiKeyName && rawSecret) {
          const apiSecret = rawSecret.replace(/\\n/g, '\n');
          const path = '/api/v3/brokerage/accounts';
          
          const token = jwt.sign(
            { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `GET api.coinbase.com${path}` },
            apiSecret,
            { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
          );

          const resp = await fetch(`https://api.coinbase.com${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
          
          if (resp.ok) {
              const data = await resp.json();
              const fiatAccounts = data.accounts?.filter(a => a.currency === 'USD' || a.currency === 'USDC') || [];
              liveBalance = fiatAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance.value), 0);
          }
        }
    } catch (cryptoErr) {
        console.warn("[PORTFOLIO CRYPTO WARN]: Failed to parse Coinbase API Secret.");
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
      price: currentMarketPrice // Sends the successful price payload to the frontend
    });

  } catch (err) {
    console.error("[PORTFOLIO FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}