// pages/api/execute-trade.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const data = req.body;
    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';

    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    if (!apiKeyName || !apiSecret) {
      throw new Error("Missing Coinbase API credentials in environment.");
    }

    // SCRUBBER: Format the ECDSA key correctly
    const formattedSecret = apiSecret.replace(/\\n/g, '\n');

    // Format Product String (DOGEUSDT -> DOGE-USDT)
    let rawSymbol = data.symbol || 'DOGEUSDT';
    rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '');
    const coinbaseProduct = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const qty = (data.qty || 10).toString();

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Side: ${side}`);

    // --- JWT GENERATOR FOR COINBASE CDP ---
    // This perfectly signs the request exactly how Coinbase Advanced Trade demands
    const generateToken = (method, path) => {
      return jwt.sign(
        {
          iss: 'cdp',
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          sub: apiKeyName,
          uri: `${method} api.coinbase.com${path}`,
        },
        formattedSecret,
        {
          algorithm: 'ES256',
          header: {
            kid: apiKeyName,
            nonce: crypto.randomBytes(16).toString('hex'),
          },
        }
      );
    };

    let executionPrice = data.price || 0;
    let executionStatus = 'simulated';

    if (!isPaper) {
      // 🔴 LIVE TRADE EXECUTION
      const path = '/api/v3/brokerage/orders';
      const token = generateToken('POST', path);
      
      const payload = {
        client_order_id: `nexus_${Date.now()}`,
        product_id: coinbaseProduct,
        side: side,
        order_configuration: {
          // Note: Coinbase requires 'quote_size' (USD amount) for Buys, and 'base_size' (Coin amount) for Sells
          market_market_ioc: side === 'BUY' ? { quote_size: qty } : { base_size: qty }
        }
      };

      const resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const result = await resp.json();
      if (!resp.ok) throw new Error(`Coinbase Reject: ${JSON.stringify(result)}`);
      
      executionPrice = result.success_response?.average_price || data.price;
      executionStatus = 'filled';
      
    } else {
      // 🟢 PAPER DRY-RUN (Fetch Live Market Price to verify Keys)
      const path = `/api/v3/brokerage/products/${coinbaseProduct}`;
      const token = generateToken('GET', path);

      const resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      const result = await resp.json();
      if (!resp.ok) throw new Error(`Coinbase Reject: ${JSON.stringify(result)}`);
      
      executionPrice = parseFloat(result.price || data.price);
      console.log(`[PAPER] Verified live market price: $${executionPrice}`);
    }

    // Log the actualized execution to Supabase
    const { error: logError } = await supabase.from('trade_logs').insert([{
      symbol: rawSymbol,
      side: side,
      entry_price: executionPrice,
      execution_mode: mode,
      pnl: 0,
      mci_at_entry: data.mci || 0,
      exit_time: new Date().toISOString()
    }]);

    if (logError) throw new Error(`Supabase Error: ${logError.message}`);

    return res.status(200).json({ 
      status: executionStatus, 
      product: coinbaseProduct, 
      price: executionPrice 
    });

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}