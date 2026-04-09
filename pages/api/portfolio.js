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
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    let liveBalance = 0;
    const initialPaperFunds = 5000;
    let paperBalance = initialPaperFunds;

    // 1. Fetch LIVE Balance from Coinbase
    if (apiKeyName && apiSecret) {
      const path = '/api/v3/brokerage/accounts';
      const token = jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `GET api.coinbase.com${path}` },
        apiSecret,
        { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
      );

      const resp = await fetch(`https://api.coinbase.com${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        // Sum up USD and USDC available balances
        const fiatAccounts = data.accounts.filter(a => a.currency === 'USD' || a.currency === 'USDC');
        liveBalance = fiatAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance.value), 0);
      }
    }

    // 2. Fetch PAPER Balance from Database (Initial + Sum of all Paper PnL)
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