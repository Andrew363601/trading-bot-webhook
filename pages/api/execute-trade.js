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
   let rawSymbol = data.symbol || 'ETH-PERP';
   rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '').toUpperCase().trim();
   
   let coinbaseProduct = rawSymbol;
   if (!coinbaseProduct.includes('-')) {
       if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
       else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
       else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
   }

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

    // 1. EXTRACT ADVANCED TRACKING VARIABLES
    const strategyId = data.strategy_id || 'MANUAL';
    const version = data.version || 'v1.0';
    const leverage = data.leverage || 1;
    const marketType = data.market_type || 'FUTURES'; 
    const orderType = data.order_type || 'MARKET'; // Dynamic extraction
    const tradeReason = data.reason || null; // Extracts the Oracle's reasoning
    
    let tpPrice = data.tp_price || null;
    let slPrice = data.sl_price || null;

    // 2. ISOLATE OPEN TRADES 
    const { data: openTrades } = await supabase
      .from('trade_logs')
      .select('*')
      .eq('symbol', rawSymbol)
      .eq('strategy_id', strategyId) 
      .is('exit_price', null)
      .order('id', { ascending: false })
      .limit(1);
    
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    // THE LIQUIDATION LOCK: Ensure closure quantity perfectly matches open quantity
    let orderQty = parseFloat(data.qty || 10);
    if (openTrade && openTrade.side !== side) {
        orderQty = parseFloat(openTrade.qty || orderQty);
    }

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Type: ${orderType} | Side: ${side} | Leverage: ${leverage}x | Qty: ${orderQty}`);

    const generateToken = (method, path) => {
      // THE ES256 FIX: Convert the string into a strict PEM Private Key object
      const privateKey = crypto.createPrivateKey({
        key: formattedSecret,
        format: 'pem'
      });

      return jwt.sign(
        {
          iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
          sub: apiKeyName, uri: `${method} api.coinbase.com${path}`,
        },
        privateKey, // Pass the object, not the string
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
        order_configuration: {}
      };

      // --- NEW: DYNAMIC ORDER ROUTING ---
      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = {
              base_size: orderQty.toString(),
              limit_price: executionPrice.toString()
          };
      } else {
          payload.order_configuration.market_market_ioc = { 
              base_size: orderQty.toString() 
          };
      }

      const resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const result = await resp.json();
      if (!resp.ok) throw new Error(`Coinbase Reject: ${JSON.stringify(result)}`);
      
      // If it's a LIMIT order, it won't have an immediate fill average_price
      executionPrice = result.success_response?.average_price || executionPrice;
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      // --- NEW: THE TP/SL BRACKET ORDER DEPLOYMENT ---
      // Only fire instantly to the exchange if the entry was a MARKET order and we have TP/SL targets
      if (orderType === 'MARKET' && tpPrice && slPrice) {
          console.log(`[BRACKET] Entry filled. Deploying Take Profit at $${tpPrice} and Stop Loss at $${slPrice}...`);
          
          // If we bought, the protection orders need to be sells (and vice versa)
          const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
          const stopDir = side === 'BUY' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';

          // 1. Fire Stop Loss (Critical Capital Protection - Sent as a Stop Limit)
          try {
              const slPayload = {
                  client_order_id: `nx_sl_${Date.now()}`,
                  product_id: coinbaseProduct,
                  side: closingSide,
                  order_configuration: {
                      stop_limit_stop_limit_gtc: {
                          stop_direction: stopDir,
                          stop_price: slPrice.toString(),
                          limit_price: slPrice.toString(),
                          base_size: orderQty.toString()
                      }
                  }
              };
              const slToken = generateToken('POST', path);
              const slResp = await fetch(`https://api.coinbase.com${path}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${slToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify(slPayload)
              });
              if (slResp.ok) console.log(`[BRACKET] Stop Loss successfully locked on exchange.`);
              else console.error(`[BRACKET WARN] Stop Loss rejected:`, await slResp.text());
          } catch (e) { console.error("[BRACKET ERROR] SL failed:", e.message); }

          // 2. Fire Take Profit (Sent as a standard Limit order)
          try {
              const tpPayload = {
                  client_order_id: `nx_tp_${Date.now()}`,
                  product_id: coinbaseProduct,
                  side: closingSide,
                  order_configuration: {
                      limit_limit_gtc: {
                          limit_price: tpPrice.toString(),
                          base_size: orderQty.toString()
                      }
                  }
              };
              const tpToken = generateToken('POST', path);
              const tpResp = await fetch(`https://api.coinbase.com${path}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${tpToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify(tpPayload)
              });
              if (tpResp.ok) console.log(`[BRACKET] Take Profit successfully resting on exchange.`);
              else console.error(`[BRACKET WARN] Take Profit rejected:`, await tpResp.text());
          } catch (e) { console.error("[BRACKET ERROR] TP failed:", e.message); }
      }
      
    } else {
      // 🟢 PAPER DRY-RUN
      // THE FIX: Route paper price checks to the Spot market to bypass strict Futures API key checks
      let paperProduct = coinbaseProduct;
      if (paperProduct.includes('-PERP')) {
          paperProduct = paperProduct.split('-')[0] + '-USD';
      }

      const path = `/api/v3/brokerage/products/${paperProduct}`;
      const token = generateToken('GET', path);

      const resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      const result = await resp.json();
      if (!resp.ok) throw new Error(`Coinbase Reject: ${JSON.stringify(result)}`);
      
      // Only overwrite the price if it's a MARKET order. Limit orders stay at the requested price.
      if (orderType === 'MARKET') executionPrice = parseFloat(result.price || data.price);
      
      console.log(`[PAPER] Verified ${orderType} price: $${executionPrice}`);
    }

    // 3. PROPER STATE MANAGEMENT 
    if (openTrade) {
      if (openTrade.side !== side) {
        const pnl = openTrade.side === 'BUY' 
          ? (executionPrice - openTrade.entry_price) * orderQty
          : (openTrade.entry_price - executionPrice) * orderQty;

// Preserves the original Oracle entry critique and appends the exit reason to the bottom
const updatedReason = openTrade.reason 
? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${tradeReason || 'MANUAL_CLOSE'}` 
: (tradeReason || 'MANUAL_CLOSE');

const { error: updateError } = await supabase.from('trade_logs').update({
exit_price: executionPrice,
pnl: pnl,
exit_time: new Date().toISOString(),
reason: updatedReason // <--- Safe append!
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
        qty: orderQty, 
        leverage: leverage,
        market_type: marketType,
        tp_price: tpPrice,
        sl_price: slPrice,
        reason: tradeReason // <--- Logs the Oracle's Conviction logic
      }]);

      if (insertError) throw new Error(`Supabase Insert Error: ${insertError.message}`);
      executionStatus = orderType === 'LIMIT' ? 'opened_limit_position' : 'opened_position';
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