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
    const orderType = data.order_type || 'MARKET'; 
    const tradeReason = data.reason || null; 
    
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

    // --- THE CLOSING DETECTOR ---
    const isClosing = openTrade && openTrade.side !== side;

    // THE LIQUIDATION LOCK: Ensure closure quantity perfectly matches open quantity
    let orderQty = parseFloat(data.qty || 10);
    if (isClosing) {
        orderQty = parseFloat(openTrade.qty || orderQty);
    }

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Type: ${orderType} | Side: ${side} | Leverage: ${leverage}x | Qty: ${orderQty}`);

    const generateToken = (method, path) => {
      const privateKey = crypto.createPrivateKey({
        key: formattedSecret,
        format: 'pem'
      });

      return jwt.sign(
        {
          iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
          sub: apiKeyName, uri: `${method} api.coinbase.com${path}`,
        },
        privateKey, 
        { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
      );
    };

    let executionPrice = data.price || 0;
    let executionStatus = 'simulated';

    // Helper: CDE Venue restriction check
    const isCDE = coinbaseProduct.endsWith('-CDE');

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

      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = {
              base_size: orderQty.toString(),
              limit_price: executionPrice.toString()
          };
          
          // THE FIX: Only append reduce_only if it is NOT a CDE derivative
          if (isClosing && !isCDE) {
              payload.order_configuration.limit_limit_gtc.reduce_only = true;
          }
      } else {
          payload.order_configuration.market_market_ioc = { 
              base_size: orderQty.toString() 
          };
      }

      let resp = await fetch(`https://api.coinbase.com${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      let result = await resp.json();

      // --- THE AUTO-RECOVERY MATRIX ---
      if (!resp.ok || result.success === false) {
          const failReason = result.error_response?.preview_failure_reason || result.error_response?.error;
          
          if (failReason === 'PREVIEW_ORDER_SIZE_EXCEEDS_BRACKETED_POSITION' || failReason === 'PREVIEW_INSUFFICIENT_FUNDS_FOR_FUTURES') {
              console.log(`[EXECUTE RECOVERY] Coinbase physical bracket conflict detected. Auto-retrying as reduce_only...`);
              
              if (payload.order_configuration.limit_limit_gtc && !isCDE) {
                  payload.order_configuration.limit_limit_gtc.reduce_only = true;
                  payload.client_order_id = `nexus_retry_${Date.now()}`; // Refresh ID

                  const retryToken = generateToken('POST', path);
                  resp = await fetch(`https://api.coinbase.com${path}`, {
                      method: 'POST', headers: { 'Authorization': `Bearer ${retryToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                  });
                  result = await resp.json();
              }
          }
      }
      
      if (!resp.ok) throw new Error(`Coinbase HTTP Reject: ${JSON.stringify(result)}`);
      if (result.success === false || result.error_response) {
          const errMsg = result.error_response?.message || result.failure_reason?.error_message || JSON.stringify(result);
          throw new Error(`Coinbase Order Rejected: ${errMsg}`);
      }
      
      executionPrice = result.success_response?.average_price || executionPrice;
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      // --- THE TP/SL BRACKET ORDER DEPLOYMENT ---
      if (!isClosing && orderType === 'MARKET' && tpPrice && slPrice) {
          console.log(`[BRACKET] Entry filled. Deploying Take Profit at $${tpPrice} and Stop Loss at $${slPrice}...`);
          const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
          const stopDir = side === 'BUY' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';

          // 1. Fire Stop Loss 
          try {
              const slPayload = {
                  client_order_id: `nx_sl_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                  order_configuration: { 
                      stop_limit_stop_limit_gtc: { 
                          stop_direction: stopDir, stop_price: slPrice.toString(), limit_price: slPrice.toString(), base_size: orderQty.toString() 
                      } 
                  }
              };
              
              // THE FIX: Append reduce_only ONLY if it's not a CDE derivative
              if (!isCDE) slPayload.order_configuration.stop_limit_stop_limit_gtc.reduce_only = true;

              await fetch(`https://api.coinbase.com${path}`, {
                  method: 'POST', headers: { 'Authorization': `Bearer ${generateToken('POST', path)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(slPayload)
              });
          } catch (e) { console.error("[BRACKET ERROR] SL failed"); }

          // 2. Fire Take Profit 
          try {
              const tpPayload = {
                  client_order_id: `nx_tp_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                  order_configuration: { 
                      limit_limit_gtc: { 
                          limit_price: tpPrice.toString(), base_size: orderQty.toString() 
                      } 
                  }
              };

              // THE FIX: Append reduce_only ONLY if it's not a CDE derivative
              if (!isCDE) tpPayload.order_configuration.limit_limit_gtc.reduce_only = true;

              await fetch(`https://api.coinbase.com${path}`, {
                  method: 'POST', headers: { 'Authorization': `Bearer ${generateToken('POST', path)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tpPayload)
              });
          } catch (e) { console.error("[BRACKET ERROR] TP failed"); }
      }
      
    } else {
      // 🟢 PAPER DRY-RUN
      executionStatus = 'simulated';
      console.log(`[PAPER] Simulated ${side} for ${rawSymbol} at $${executionPrice}`);
    }

    // 3. DATABASE STATE MANAGEMENT 
    // The Phantom Blocker: Prevents ghost trades if Watchdog already closed it natively
    const isForcedExit = tradeReason && (tradeReason.includes('STOP_LOSS') || tradeReason.includes('TAKE_PROFIT') || tradeReason.includes('STALE_LIMIT') || tradeReason.includes('EMERGENCY_CLOSE'));

    if (openTrade) {
      if (isClosing) {
        console.log(`[SUPABASE] Closing existing ${openTrade.side} position for ${rawSymbol}...`);
        const pnl = openTrade.side === 'BUY' 
          ? (executionPrice - openTrade.entry_price) * orderQty
          : (openTrade.entry_price - executionPrice) * orderQty;

        const updatedReason = openTrade.reason 
            ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${tradeReason || 'MANUAL_CLOSE'}` 
            : (tradeReason || 'MANUAL_CLOSE');

        const { error: updateError } = await supabase.from('trade_logs').update({
            exit_price: executionPrice,
            pnl: pnl,
            exit_time: new Date().toISOString(),
            reason: updatedReason 
        }).eq('id', openTrade.id);

        if (updateError) throw new Error(`Supabase Update Error: ${updateError.message}`);
        executionStatus = 'closed_position';
      } else {
        console.log(`[SUPABASE] Ignored duplicate ${side} order for ${rawSymbol}.`);
        return res.status(200).json({ status: "ignored_already_open", product: coinbaseProduct });
      }
    } else {
      
      if (isForcedExit) {
          console.log(`[SUPABASE] Ignored phantom ${side} order. Trade already closed natively.`);
          return res.status(200).json({ status: "already_closed_natively", product: coinbaseProduct });
      }

      console.log(`[SUPABASE] Inserting brand new ${side} position for ${rawSymbol}...`);
      const { error: insertError } = await supabase.from('trade_logs').insert([{
        symbol: rawSymbol,
        side: side,
        entry_price: executionPrice,
        execution_mode: mode,
        strategy_id: strategyId,
        version: version,
        qty: orderQty, 
        leverage: leverage,
        market_type: marketType,
        tp_price: tpPrice,
        sl_price: slPrice,
        reason: tradeReason 
      }]);

      if (insertError) throw new Error(`Supabase Insert Error: ${insertError.message}`);
      executionStatus = orderType === 'LIMIT' ? 'opened_limit_position' : 'opened_position';
    }

    return res.status(200).json({ status: executionStatus, product: coinbaseProduct, price: executionPrice });

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}