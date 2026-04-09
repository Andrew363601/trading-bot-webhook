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
    let data = req.body;

    // FIX 1: PARSE TRADINGVIEW STRINGS
    // If the payload is a raw string from TV, clean and parse it into JSON
    if (typeof data === 'string') {
      try {
        if (data.startsWith('LOG_TRADE:')) data = JSON.parse(data.replace('LOG_TRADE:', ''));
        else if (data.startsWith('EXECUTE_ORDER:')) data = JSON.parse(data.replace('EXECUTE_ORDER:', ''));
        else data = JSON.parse(data);
      } catch (e) {
        throw new Error("Invalid payload format received.");
      }
    }

    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API credentials in environment.");

    const formattedSecret = apiSecret.replace(/\\n/g, '\n');

    // Format Product String (DOGEUSDT -> DOGE-USDT)
    let rawSymbol = data.symbol || data.symbol_tv || 'DOGEUSDT';
    rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '');
    const coinbaseProduct = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const qty = (data.qty || 10).toString();

    // FIX 2: STATE MANAGEMENT (Check for open trades)
    // Find if there is an active trade for this symbol that hasn't been closed yet
    const { data: openTrades } = await supabase
      .from('trade_logs')
      .select('*')
      .eq('symbol', rawSymbol)
      .is('exit_price', null)
      .order('id', { ascending: false })
      .limit(1);
    
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    // Is this just a "LOG_TRADE" event from TV? (No execution, just DB update)
    if (data.pnl !== undefined && data.exit_price !== undefined) {
      if (openTrade) {
        await supabase.from('trade_logs').update({
          exit_price: data.exit_price,
          pnl: data.pnl,
          exit_time: new Date().toISOString()
        }).eq('id', openTrade.id);
      }
      return res.status(200).json({ status: "Trade Logged Successfully" });
    }

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Side: ${side}`);

    const generateToken = (method, path) => {
      return jwt.sign(
        {
          iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
          sub: apiKeyName, uri: `${method} api.coinbase.com${path}`,
        },
        formattedSecret,
        { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
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
          market_market_ioc: side === 'BUY' ? { quote_size: qty } : { base_size: qty }
        }
      };

      const resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const result = await resp.json();
      if (!resp.ok) throw new Error(`Coinbase Reject: ${JSON.stringify(result)}`);
      
      executionPrice = result.success_response?.average_price || data.price;
      executionStatus = 'filled';
      
    } else {
      // 🟢 PAPER DRY-RUN
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

 // FIX: PROPER STATE MANAGEMENT (Single-Entry Mode)
 if (openTrade) {
    if (openTrade.side !== side) {
      // CLOSE REVERSAL: The signal flipped. Close the old trade.
      const pnl = openTrade.side === 'BUY' 
        ? executionPrice - openTrade.entry_price 
        : openTrade.entry_price - executionPrice;

      const { error: updateError } = await supabase.from('trade_logs').update({
        exit_price: executionPrice,
        pnl: pnl,
        exit_time: new Date().toISOString()
      }).eq('id', openTrade.id);

      if (updateError) throw new Error(`Supabase Update Error: ${updateError.message}`);
      executionStatus = 'closed_position';
      
    } else {
      // ALREADY IN: We already have an open trade in this direction. Do nothing.
      console.log(`[ENGINE] Position already open for ${coinbaseProduct}. Ignoring signal.`);
      return res.status(200).json({ status: "ignored_already_open", product: coinbaseProduct });
    }
  } else {
    // BRAND NEW TRADE: No open trades exist.
    const { error: insertError } = await supabase.from('trade_logs').insert([{
      symbol: rawSymbol,
      side: side,
      entry_price: executionPrice,
      execution_mode: mode,
      mci_at_entry: data.mci || 0,
    }]);

    if (insertError) throw new Error(`Supabase Insert Error: ${insertError.message}`);
    executionStatus = 'opened_position';
  }

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