// Unleashing Vercel Pro limit (5 full minutes) to prevent execution timeouts
export const maxDuration = 300;

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

    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET;

    if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API credentials in environment.");

    const formattedSecret = apiSecret.replace(/\\n/g, '\n');

    // --- THE PERPETUAL FUTURES FIX ---
    // Bulletproof symbol parsing so it perfectly matches the database and Coinbase API
    let rawSymbol = data.symbol || 'DOGE-PERP-INTX';
    rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '').toUpperCase().trim();
    
    let coinbaseProduct = rawSymbol;
    if (!coinbaseProduct.includes('-')) {
        if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
        else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
        else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP-INTX');
    }
    if (coinbaseProduct.endsWith('-PERP')) {
        coinbaseProduct = coinbaseProduct + '-INTX';
    }

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const qty = (data.qty || 10).toString();

    // 1. EXTRACT ADVANCED TRACKING VARIABLES
    const strategyId = data.strategy_id || 'MANUAL';
    const version = data.version || 'v1.0';
    const leverage = data.leverage || 1;
    const marketType = data.market_type || 'FUTURES'; // Defaulting to Futures!
    let tpPrice = data.tp_price || null;
    let slPrice = data.sl_price || null;

    // 2. ISOLATE OPEN TRADES (By Symbol AND Strategy ID)
    const { data: openTrades } = await supabase
      .from('trade_logs')
      .select('*')
      .eq('symbol', rawSymbol)
      .eq('strategy_id', strategyId) 
      .is('exit_price', null)
      .order('id', { ascending: false })
      .limit(1);
    
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Side: ${side} | Leverage: ${leverage}x`);

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
      // 🔴 LIVE TRADE EXECUTION (Perfectly formatted for Coinbase Futures)
      const path = '/api/v3/brokerage/orders';
      const token = generateToken('POST', path);
      
      const payload = {
        client_order_id: `nexus_${Date.now()}`,
        product_id: coinbaseProduct,
        side: side,
        order_configuration: {
          // Futures strictly require base_size for BOTH longs and shorts
          market_market_ioc: { base_size: qty } 
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

    // 3. PROPER STATE MANAGEMENT (With PnL Scaling)
    if (openTrade) {
      if (openTrade.side !== side) {
        // CLOSE TRADE: Calculate PnL accurately using position quantity
        const pnl = openTrade.side === 'BUY' 
          ? (executionPrice - openTrade.entry_price) * (openTrade.qty || 1)
          : (openTrade.entry_price - executionPrice) * (openTrade.qty || 1);

        const { error: updateError } = await supabase.from('trade_logs').update({
          exit_price: executionPrice,
          pnl: pnl,
          exit_time: new Date().toISOString()
        }).eq('id', openTrade.id);

        if (updateError) throw new Error(`Supabase Update Error: ${updateError.message}`);
        executionStatus = 'closed_position';
      } else {
        return res.status(200).json({ status: "ignored_already_open", product: coinbaseProduct });
      }
    } else {
      // BRAND NEW ISOLATED TRADE
      const { error: insertError } = await supabase.from('trade_logs').insert([{
        symbol: rawSymbol,
        side: side,
        entry_price: executionPrice,
        execution_mode: mode,
        mci_at_entry: data.mci || 0,
        strategy_id: strategyId,
        version: version,
        qty: parseFloat(qty),
        leverage: leverage,
        market_type: marketType,
        tp_price: tpPrice,
        sl_price: slPrice
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