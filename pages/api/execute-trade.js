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

// --- 📱 DISCORD MESSENGER ---
async function sendDiscordAlert(title, description, color) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [{ title, description, color, timestamp: new Date().toISOString() }] })
        });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

// 🟢 THE FIX: Universal Metrics Dictionary to completely remove hardcoded elements
const getAssetMetrics = (symbol) => {
    let multiplier = 1.0;
    let tickSize = 0.01;
    
    if (symbol.includes('ETP') || symbol.includes('ETH')) { multiplier = 0.1; tickSize = 0.50; }
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 1.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    
    return { multiplier, tickSize };
};

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

   let rawSymbol = data.symbol || 'ETH-PERP';
   rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '').toUpperCase().trim();
   
   let coinbaseProduct = rawSymbol;
   if (!coinbaseProduct.includes('-')) {
       if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
       else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
       else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
   }

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

    const strategyId = data.strategy_id || 'MANUAL';
    const version = data.version || 'v1.0';
    const leverage = data.leverage || 1;
    const marketType = data.market_type || 'FUTURES'; 
    const orderType = data.order_type || 'MARKET'; 
    const tradeReason = data.reason || null; 
    
    let tpPrice = data.tp_price || null;
    let slPrice = data.sl_price || null;

    const { data: openTrades } = await supabase.from('trade_logs').select('*').eq('symbol', rawSymbol).eq('strategy_id', strategyId).is('exit_price', null).order('id', { ascending: false }).limit(1);
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    const isClosing = openTrade && openTrade.side !== side;

    // 🟢 THE FIX: Strictly enforce whole numbers for Contracts to prevent Exchange rejections
    let orderQty = Math.max(1, Math.round(parseFloat(data.qty || 10)));
    if (isClosing) {
        orderQty = Math.max(1, Math.round(parseFloat(openTrade.qty || orderQty)));
    }

    const generateToken = (method, path) => {
      const privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });
      return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${path}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
      );
    };

    const { multiplier, tickSize } = getAssetMetrics(coinbaseProduct);

    let executionPrice = data.price ? parseFloat((Math.round(parseFloat(data.price) / tickSize) * tickSize).toFixed(4)) : 0;
    if (tpPrice) tpPrice = parseFloat((Math.round(parseFloat(tpPrice) / tickSize) * tickSize).toFixed(4));
    if (slPrice) slPrice = parseFloat((Math.round(parseFloat(slPrice) / tickSize) * tickSize).toFixed(4));

    let executionStatus = 'simulated';

    if (!isPaper) {
      if (isClosing) {
          try {
              const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
              const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', orderPath)}` } });
              
              if (orderResp.ok) {
                  const orderData = await orderResp.json();
                  if (orderData.orders && orderData.orders.length > 0) {
                      const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                      await fetch(`https://api.coinbase.com${cancelPath}`, {
                          method: 'POST', 
                          headers: { 'Authorization': `Bearer ${generateToken('POST', cancelPath)}`, 'Content-Type': 'application/json' }, 
                          body: JSON.stringify({ order_ids: orderData.orders.map(o => o.order_id) })
                      });
                      
                      console.log(`[FLOOR SWEEPER] Nuked ${orderData.orders.length} orphaned brackets. Pausing 2s for exchange clearing...`);
                      await new Promise(resolve => setTimeout(resolve, 2000));
                  }
              }
          } catch (sweepErr) {
              console.error("[SWEEP FAULT]:", sweepErr.message);
          }
      }

      const path = '/api/v3/brokerage/orders';
      const token = generateToken('POST', path);
      
      const payload = {
        client_order_id: `nexus_${Date.now()}`, product_id: coinbaseProduct, side: side, order_configuration: {}
      };

      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = { base_size: orderQty.toString(), limit_price: executionPrice.toString() };
      } else {
          payload.order_configuration.market_market_ioc = { base_size: orderQty.toString() };
      }

      let resp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let result = await resp.json();
      
      if (!resp.ok || result.success === false || result.error_response) {
          const errMsg = result.error_response?.preview_failure_reason || result.error_response?.error || result.failure_reason?.error_message || JSON.stringify(result);
          
          if (errMsg.includes('INSUFFICIENT_FUNDS_FOR_FUTURES') || errMsg.includes('INSUFFICIENT_FUNDS')) {
              console.log("[AUTO-FUNDING] Margin wall hit. Attempting to siphon funds from Spot...");
              try {
                  const portPath = '/api/v3/brokerage/portfolios';
                  const portResp = await fetch(`https://api.coinbase.com${portPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', portPath)}` } });
                  const portData = await portResp.json();

                  const spotWallet = portData.portfolios?.find(p => p.type === 'DEFAULT' || p.name === 'Primary');
                  const futuresWallet = portData.portfolios?.find(p => p.type === 'FUTURES' || p.name.includes('Derivatives') || p.name.includes('Futures'));

                  if (spotWallet && futuresWallet) {
                      const transferPath = '/api/v3/brokerage/portfolios/transfer';
                      const transferPayload = {
                          source_portfolio_uuid: spotWallet.uuid,
                          target_portfolio_uuid: futuresWallet.uuid,
                          funds: { value: "60.00", currency: "USD" } 
                      };

                      const transferResp = await fetch(`https://api.coinbase.com${transferPath}`, {
                          method: 'POST',
                          headers: { 'Authorization': `Bearer ${generateToken('POST', transferPath)}`, 'Content-Type': 'application/json' },
                          body: JSON.stringify(transferPayload)
                      });

                      if (transferResp.ok) {
                          await sendDiscordAlert(`💸 Auto-Funding Triggered`, `**Asset:** ${rawSymbol}\n**Action:** Automatically transferred $60.00 to Derivatives to cover margin requirements.`, 3447003);
                          await new Promise(resolve => setTimeout(resolve, 2000)); 

                          const retryToken = generateToken('POST', path);
                          resp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${retryToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                          result = await resp.json();
                          
                          if (!resp.ok || result.success === false) {
                               throw new Error(`Retry failed after funding: ${JSON.stringify(result)}`);
                          }
                      } else {
                          const transferErrData = await transferResp.json();
                          throw new Error(`API Transfer call was rejected by Coinbase. ${JSON.stringify(transferErrData)}`);
                      }
                  } else {
                      throw new Error("Could not locate the correct Spot/Futures Portfolio UUIDs.");
                  }
              } catch (fundErr) {
                  throw new Error(`Auto-Funding sequence failed: ${fundErr.message}`);
              }
          } else {
              throw new Error(`Coinbase Order Rejected: ${errMsg}`);
          }
      }
      
      executionPrice = result.success_response?.average_price ? parseFloat(result.success_response.average_price) : executionPrice;
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      if (!isClosing && orderType === 'MARKET' && tpPrice && slPrice) {
          const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
          try {
              const ocoPayload = {
                  client_order_id: `nx_oco_exec_${Date.now()}`, product_id: coinbaseProduct, side: closingSide,
                  order_configuration: { trigger_bracket_gtc: { limit_price: tpPrice.toString(), stop_trigger_price: slPrice.toString(), base_size: orderQty.toString() } }
              };
              const ocoResp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateToken('POST', path)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
              const ocoResult = await ocoResp.json();
              if (!ocoResp.ok || ocoResult.success === false) {
                  console.error(`[BRACKET REJECT] OCO Failed:`, JSON.stringify(ocoResult));
                  await sendDiscordAlert(`⚠️ Bracket Failed: ${rawSymbol}`, `**Action:** Missing TP/SL protection!\n**Details:** Exchange rejected the OCO order.`, 15548997);
              } else {
                  await sendDiscordAlert(`🎯 Brackets Deployed: ${rawSymbol}`, `**Take Profit:** $${tpPrice}\n**Stop Loss:** $${slPrice}\n**Status:** Active on Exchange`, 10181046); 
              }
          } catch (e) { console.error("[BRACKET FATAL] OCO failed:", e.message); }
      }
    }

    const isForcedExit = tradeReason && (tradeReason.includes('STOP_LOSS') || tradeReason.includes('TAKE_PROFIT') || tradeReason.includes('STALE_LIMIT') || tradeReason.includes('EMERGENCY_CLOSE'));

    if (openTrade) {
      if (isClosing) {
        const pnl = openTrade.side === 'BUY' ? (executionPrice - openTrade.entry_price) * orderQty * multiplier : (openTrade.entry_price - executionPrice) * orderQty * multiplier;
        const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${tradeReason || 'MANUAL_CLOSE'}` : (tradeReason || 'MANUAL_CLOSE');

        const { error: updateError } = await supabase.from('trade_logs').update({ exit_price: executionPrice, pnl: parseFloat(pnl.toFixed(4)), exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
        if (updateError) throw new Error(`Supabase Update Error: ${updateError.message}`);
        executionStatus = 'closed_position';
        
        await sendDiscordAlert(`🏁 Position Closed: ${rawSymbol}`, `**Exit Price:** $${executionPrice}\n**Realized PnL:** $${pnl.toFixed(4)}\n**Trigger:** ${tradeReason || 'Signal Reversal'}`, pnl >= 0 ? 5763719 : 15548997);

      } else {
        return res.status(200).json({ status: "ignored_already_open", product: coinbaseProduct });
      }
    } else {
      if (isForcedExit) return res.status(200).json({ status: "already_closed_natively", product: coinbaseProduct });

      const { error: insertError } = await supabase.from('trade_logs').insert([{
        symbol: rawSymbol, side: side, entry_price: executionPrice, execution_mode: mode, strategy_id: strategyId, version: version, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason 
      }]);

      if (insertError) throw new Error(`Supabase Insert Error: ${insertError.message}`);
      executionStatus = orderType === 'LIMIT' ? 'opened_limit_position' : 'opened_position';
      
      const rationaleText = tradeReason ? `\n\n**🧠 Oracle Rationale:**\n_${tradeReason}_` : '';
      const actionTitle = orderType === 'LIMIT' ? `⏳ Limit Order Placed: ${rawSymbol}` : `🚀 New Position Opened: ${rawSymbol}`;
      const targetText = (tpPrice && slPrice) ? `\n**Target TP:** $${tpPrice}\n**Target SL:** $${slPrice}` : `\n**Targets:** Dynamic`;

      await sendDiscordAlert(actionTitle, `**Side:** ${side}\n**Entry Price:** $${executionPrice}\n**Qty:** ${orderQty}\n**Mode:** ${mode}${targetText}${rationaleText}`, 3447003); 
    }

    return res.status(200).json({ status: executionStatus, product: coinbaseProduct, price: executionPrice });

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    await sendDiscordAlert("❌ Execution Fault", `**Error:** ${err.message}`, 15548997);
    return res.status(500).json({ error: err.message });
  }
}