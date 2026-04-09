// pages/api/portfolio.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Advanced Scrubber: Rebuilds flattened or malformed PEM keys
const formatPrivateKey = (key) => {
  if (!key) return '';
  let formatted = key.replace(/^["']|["']$/g, ''); // Remove wrapping quotes
  formatted = formatted.replace(/\\n/g, '\n'); // Convert literal \n
  
  // If the key got flattened with spaces instead of newlines
  if (formatted.includes('-----BEGIN') && !formatted.includes('\n')) {
     const base64Body = formatted
        .replace('-----BEGIN EC PRIVATE KEY-----', '')
        .replace('-----END EC PRIVATE KEY-----', '')
        .replace(/\s+/g, ''); // Strip all spaces from the base64 core
     
     formatted = `-----BEGIN EC PRIVATE KEY-----\n${base64Body}\n-----END EC PRIVATE KEY-----`;
  }
  return formatted;
};

export default async function handler(req, res) {
  try {
    const apiKeyName = process.env.COINBASE_API_KEY;
    const rawSecret = process.env.COINBASE_API_SECRET;
    
    let liveBalance = 0;
    const initialPaperFunds = 5000;
    let paperBalance = initialPaperFunds;

    // 1. Fetch LIVE Balance from Coinbase
    if (apiKeyName && rawSecret) {
      const apiSecret = formatPrivateKey(rawSecret);
      const path = '/api/v3/brokerage/accounts';
      
      const token = jwt.sign(
        { 
          iss: 'cdp', 
          nbf: Math.floor(Date.now() / 1000), 
          exp: Math.floor(Date.now() / 1000) + 120, 
          sub: apiKeyName, 
          uri: `GET api.coinbase.com${path}` 
        },
        apiSecret,
        { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
      );

      const resp = await fetch(`https://api.coinbase.com${path}`, { 
        headers: { 'Authorization': `Bearer ${token}` } 
      });
      
      if (!resp.ok) {
        const errorData = await resp.json();
        throw new Error(`Coinbase Auth Reject: ${JSON.stringify(errorData)}`);
      }

      const data = await resp.json();
      
      // Filter out only USD and USDC accounts, then sum their available balances
      const fiatAccounts = data.accounts?.filter(a => a.currency === 'USD' || a.currency === 'USDC') || [];
      liveBalance = fiatAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance.value), 0);
    }

    // 2. Fetch PAPER Balance from Database
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
      paper: { balance: paperBalance, initial: initialPaperFunds }
    });

  } catch (err) {
    console.error("[PORTFOLIO FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}