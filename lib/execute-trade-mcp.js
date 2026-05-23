// lib/execute-trade-mcp.js
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { buildRadarChartUrl } from './discord-chart.js';
import { recordUsage } from './usage-meter.js';
import { retrieveAPIKey } from './secrets-manager.js';
import { validateTradeRisk } from './risk-validator.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { 
    global: { WebSocket: WebSocket },
    realtime: { transport: WebSocket }
  }
);

async function sendDiscordAlert(tenantId, { title, description, color, fields = [], imageUrl = null }) {
    if (!tenantId) return;
    
    try {
        const { data: settings } = await supabase
            .from('tenant_settings')
            .select('notification_webhook_url')
            .eq('tenant_id', tenantId)
            .single();

        const webhookUrl = settings?.notification_webhook_url || process.env.DISCORD_WEBHOOK_URL;
        if (!webhookUrl) return;

        const embed = { title, description, color, timestamp: new Date().toISOString() };
        if (fields.length > 0) embed.fields = fields;
        if (imageUrl) embed.image = { url: imageUrl };

        const response = await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[DISCORD REJECTION] Status ${response.status} for tenant ${tenantId}:`, errorText);
        }
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

const getAssetMetrics = (symbol) => {
    let multiplier = 1.0;
    let tickSize = 0.01;
    
    if (symbol.includes('ETP') || symbol.includes('ETH')) { multiplier = 0.1; tickSize = 0.50; }
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 5.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    
    return { multiplier, tickSize };
};

export async function executeTradeMCP(data) {
  try {
    const tenantId = data.tenant_id;
    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';
    
    let apiKeyName, apiSecret;
    let formattedSecret = '';

   let rawSymbol = data.symbol || 'ETH-PERP';
   rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '').toUpperCase().trim();
   
   let coinbaseProduct = rawSymbol;
   if (!coinbaseProduct.includes('-')) {
       if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
       else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
       else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
   }

    let side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

    const cleanNum = (val) => val ? parseFloat(val.toString().replace(/,/g, '')) : null;
    let incomingPrice = cleanNum(data.price);
    let tpPrice = cleanNum(data.tp_price);
    let slPrice = cleanNum(data.sl_price);

    if (tpPrice && slPrice) {
        if (side === 'BUY' && tpPrice < slPrice) {
            console.log(`[SAFETY NET] AI hallucinated 'BUY' but provided SHORT targets (TP < SL). Flipping side to SELL to preserve thesis.`);
            side = 'SELL';
        } else if (side === 'SELL' && tpPrice > slPrice) {
            console.log(`[SAFETY NET] AI hallucinated 'SELL' but provided LONG targets (TP > SL). Flipping side to BUY to preserve thesis.`);
            side = 'BUY';
        }
    }

    const strategyId = data.strategy_id || 'MANUAL';
    const version = data.version || 'v1.0';
    const leverage = data.leverage || 1;
    const marketType = data.market_type || 'FUTURES'; 
    const orderType = data.order_type || 'MARKET'; 
    const tradeReason = data.reason || null; 
    
    const isForcedExit = tradeReason && (
        tradeReason.includes('STOP_LOSS') || 
        tradeReason.includes('TAKE_PROFIT') || 
        tradeReason.includes('STALE_LIMIT') || 
        tradeReason.includes('EMERGENCY_CLOSE') ||
        tradeReason.includes('DEFENSIVE_MARKET_CLOSE') ||
        tradeReason.includes('TRIPWIRE_SECURED_PROFIT') ||
        tradeReason.includes('MANUAL_CLOSE') ||
        tradeReason.includes('CLOSE')
    );

    // Build query: if trade_id provided, query by exact id; otherwise use symbol/strategy combo
    let openTradesQuery = supabase.from('trade_logs').select('*').eq('tenant_id', tenantId);
    
    if (data.trade_id) {
        // Precise trade lookup by unique ID
        openTradesQuery = openTradesQuery.eq('id', data.trade_id);
    } else {
        // Fallback to symbol + strategy_id lookup
        openTradesQuery = openTradesQuery.eq('symbol', rawSymbol).eq('strategy_id', strategyId);
    }
    
    const { data: openTrades, error: openTradesError } = await openTradesQuery
        .is('exit_price', null)
        .order('id', { ascending: false })
        .limit(1);
    
    if (openTradesError) {
        console.error("[SUPABASE ERROR] Failed to fetch open trades:", openTradesError.message);
        // Decide how to handle this error: return, throw, or use a default empty array
        // For now, let's assume it proceeds with an empty openTrades if an error occurs
    }
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    if (openTrade && isForcedExit) {
        side = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
    }

    if (!openTrade && isForcedExit) {
        return { status: "already_closed_natively", product: coinbaseProduct };
    }

    if (tenantId) {
        await recordUsage(tenantId, 'TRADE_EXECUTED', 1);
    }

    const isClosing = openTrade && openTrade.side !== side;

    let orderQty = Math.max(1, Math.round(parseFloat(data.qty || 1)));
    if (isClosing) {
        orderQty = Math.max(1, Math.round(parseFloat(openTrade.qty || orderQty)));
    }

    const generateToken = (method, path) => {
      const privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });
      const uriPath = path.split('?')[0]; 
      return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${uriPath}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
      );
    };

    const { multiplier, tickSize } = getAssetMetrics(coinbaseProduct);

    let executionPrice = incomingPrice ? parseFloat((Math.round(incomingPrice / tickSize) * tickSize).toFixed(4)) : 0;
    if (tpPrice) tpPrice = parseFloat((Math.round(tpPrice / tickSize) * tickSize).toFixed(4));
    if (slPrice) slPrice = parseFloat((Math.round(slPrice / tickSize) * tickSize).toFixed(4));

    let telemetry = {};
    try {
        const { data: scanData, error: scanDataError } = await supabase.from('scan_results')
            .select('telemetry')
            .eq('asset', rawSymbol)
            .eq('tenant_id', tenantId) // Filter by tenant
            .order('created_at', { ascending: false })
            .limit(1);
        if (scanDataError) {
            console.error("[SUPABASE ERROR] Telemetry fetch failed:", scanDataError.message);
        } else if (scanData && scanData.length > 0) {
            telemetry = scanData[0].telemetry || {};
        }
    } catch(e) { console.error("Telemetry fetch failed (catch block):", e.message); }

    let recentCandles = [];
    try {
        // 🟢 PUBLIC CANDLE API: Works for both PAPER and LIVE (no auth needed)
        const end = Math.floor(Date.now() / 1000);
        const start = end - (300 * 50); 
        const baseAsset = rawSymbol.split('-')[0].toUpperCase();
        const spotMap = { 'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 'DOP': 'DOGE', 'LCP': 'LTC', 'AVP': 'AVAX', 'LNP': 'LINK', 'XPP': 'XRP' };
        const spotBase = spotMap[baseAsset] || baseAsset;
        const candleResp = await fetch(`https://api.exchange.coinbase.com/products/${spotBase}-USD/candles?start=${start}&end=${end}&granularity=300`);
        if (candleResp.ok) {
            const cData = await candleResp.json();
            recentCandles = (cData || []).map(c => ({
                open: parseFloat(c[3] || c[4]), 
                high: parseFloat(c[2]), 
                low: parseFloat(c[1]), 
                close: parseFloat(c[4])
            })).reverse() || [];
        }
    } catch (e) { console.error("Chart candle fetch failed", e.message); }

    const standardFields = [
        { name: "Regime", value: telemetry.macro_regime_oracle || "EVALUATING", inline: true },
        { name: "Macro POC", value: telemetry.macro_poc ? `$${telemetry.macro_poc}` : "--", inline: true },
        { name: "Micro CVD", value: telemetry.micro_cvd ? telemetry.micro_cvd.toString() : "--", inline: true }
    ];

    let executionStatus = 'simulated';
    let pendingTradeId = null;

    if (!isPaper) {
      // 🔑 Retrieve tenant API keys — only needed for LIVE trades
      if (tenantId) {
        const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
        apiKeyName = secrets.apiKey;
        apiSecret = secrets.apiSecret;
        if (!apiKeyName || !apiSecret) {
            throw new Error(`Tenant ${tenantId} has no valid Coinbase API keys configured in vault. Cannot execute trade.`);
        }
      } else {
        throw new Error("No tenant_id provided. Cannot determine which keys to use.");
      }
      if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API credentials.");
      formattedSecret = apiSecret.replace(/\\n/g, '\n');

      // 🔒 STRATEGY ACTIVE CHECK: Verify the strategy is active before executing
      if (strategyId !== 'MANUAL') {
        try {
          const { data: stratConfig } = await supabase
            .from('strategy_config')
            .select('is_active')
            .eq('tenant_id', tenantId)
            .eq('strategy', strategyId)
            .eq('asset', rawSymbol)
            .single();

          if (!stratConfig || !stratConfig.is_active) {
            console.warn(`[EXECUTE] Strategy ${strategyId} is not active for ${rawSymbol}. Rejecting trade.`);
            return { status: "strategy_not_active", reason: `Strategy ${strategyId} is not active for ${rawSymbol}.` };
          }
        } catch (e) {
          // If no config found, allow the trade (manual or webhook)
          console.log(`[EXECUTE] No strategy config found for ${strategyId}/${rawSymbol}. Proceeding.`);
        }
      }

      // 🎯 ADJUST_TP_SL: Bracket-swap path — skip main order, just cancel old brackets + place new ones
      const isBracketAdjustment = tradeReason && tradeReason.includes('ADJUST_TP_SL');
      if (isBracketAdjustment && openTrade) {
        console.log(`[EXECUTE] ADJUST_TP_SL bracket swap for ${coinbaseProduct}. Cancelling old brackets...`);
        
        // Cancel existing bracket orders
        try {
          const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
          const orderResp = await fetch(`https://api.coinbase.com${orderPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', orderPath)}` }
          });
          
          if (orderResp.ok) {
            const orderData = await orderResp.json();
            if (orderData.orders && orderData.orders.length > 0) {
              const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
              await fetch(`https://api.coinbase.com${cancelPath}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${generateToken('POST', cancelPath)}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_ids: orderData.orders.map(o => o.order_id) })
              });
              console.log(`[EXECUTE] Cancelled ${orderData.orders.length} old brackets for ADJUST_TP_SL.`);
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }
        } catch (sweepErr) {
          console.error("[ADJUST_TP_SL BRACKET CANCEL ERROR]:", sweepErr.message);
        }

        // Place new bracket with updated TP/SL
        if (tpPrice && slPrice && openTrade) {
          const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
          const path = '/api/v3/brokerage/orders';
          const actualQty = Math.max(1, Math.round(parseFloat(openTrade.qty || orderQty)));
          
          try {
            const ocoPayload = {
              client_order_id: `nx_adj_${openTrade.id}_${Date.now()}`,
              product_id: coinbaseProduct,
              side: closingSide,
              order_configuration: {
                trigger_bracket_gtc: {
                  limit_price: tpPrice.toString(),
                  stop_trigger_price: slPrice.toString(),
                  base_size: actualQty.toString()
                }
              }
            };
            const ocoResp = await fetch(`https://api.coinbase.com${path}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${generateToken('POST', path)}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(ocoPayload)
            });
            const ocoResult = await ocoResp.json();
            if (!ocoResp.ok || ocoResult.success === false) {
              const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
              console.error(`[ADJUST_TP_SL BRACKET REJECT]:`, ocoErrMsg);
              await sendDiscordAlert(tenantId, { title: `⚠️ Bracket Update Failed: ${rawSymbol}`, description: `**Action:** ADJUST_TP_SL\n**Details:** ${ocoErrMsg}`, color: 15548997 });
            } else {
              console.log(`[ADJUST_TP_SL] New brackets deployed: TP $${tpPrice}, SL $${slPrice}`);
            }
          } catch (e) {
            console.error("[ADJUST_TP_SL BRACKET PLACEMENT ERROR]:", e.message);
          }

          // Update trade_logs with new TP/SL in DB
          const dbUpdate = {};
          if (tpPrice) dbUpdate.tp_price = tpPrice;
          if (slPrice) dbUpdate.sl_price = slPrice;
          if (Object.keys(dbUpdate).length > 0) {
            await supabase.from('trade_logs').update(dbUpdate).eq('id', openTrade.id).eq('tenant_id', tenantId);
          }
        }

        return { status: "brackets_adjusted", product: coinbaseProduct, tp_price: tpPrice, sl_price: slPrice };
      }

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

      // � BALANCE CHECK: Log derivatives balance before LIVE trade for confirmation
      if (!isClosing && marketType !== 'SPOT') {
          try {
              const cfmPath = '/api/v3/brokerage/cfm/balance_summary';
              const cfmResp = await fetch(`https://api.coinbase.com${cfmPath}`, {
                  headers: { 'Authorization': `Bearer ${generateToken('GET', cfmPath)}` }
              });
              if (cfmResp.ok) {
                  const cfmData = await cfmResp.json();
                  const cfmBalance = parseFloat(
                      cfmData.balance_summary?.total_balance?.value ||
                      cfmData.balance_summary?.total_usd_balance?.value ||
                      cfmData.balance_summary?.futures_margin_balance?.value || 0
                  );
                  console.log(`[BALANCE CHECK] Derivatives balance: $${cfmBalance.toFixed(2)} (estimated margin needed: $${((orderQty * (executionPrice || incomingPrice || 0) * Math.abs(multiplier)) / Math.max(leverage, 1)).toFixed(2)})`);
                  if (cfmBalance <= 0) {
                      console.warn(`[BALANCE CHECK] Derivatives balance is $${cfmBalance.toFixed(2)}. Coinbase will auto-fund from spot at settlement if USD is fully cleared.`);
                  }
              }
          } catch (e) {
              console.error('[BALANCE CHECK] Failed:', e.message);
          }
      }

      const path = '/api/v3/brokerage/orders';
      const token = generateToken('POST', path);
      
      const entryClientId = isClosing ? `nx_close_${openTrade.id}_${Date.now()}` : `nx_entry_${Date.now()}`;
      const payload = {
        client_order_id: entryClientId, product_id: coinbaseProduct, side: side, order_configuration: {}
      };

      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = { base_size: orderQty.toString(), limit_price: executionPrice.toString() };
      } else {
          payload.order_configuration.market_market_ioc = { base_size: orderQty.toString() };
      }

      let resp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let result = await resp.json();
      
      // Handle order rejection — no trade_log to clean up (INSERT happens after order succeeds)
      if (!resp.ok || result.success === false || result.error_response) {
        const errMsg = result.error_response?.preview_failure_reason || result.error_response?.error || result.failure_reason?.error_message || JSON.stringify(result);
        const isInsufficientFunds = errMsg.includes('INSUFFICIENT_FUNDS') || errMsg.includes('insufficient_funds') || errMsg.includes('insufficient');

        if (isInsufficientFunds) {
            console.warn(`[EXECUTE] Order rejected due to INSUFFICIENT_FUNDS. This may be caused by ACH settlement holds — USD may show in your balance but hasn't cleared for futures margin. Try using a Wire Transfer or waiting 3-5 business days for ACH to settle.`);
        }
        throw new Error(`Coinbase Order Rejected: ${errMsg}`);
      }
      
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      // 👇 Order succeeded — now create the trade_log (no race with watchdog)
      if (!isClosing && !isForcedExit) {
        try {
            const { data: insertData, error: insertError } = await supabase.from('trade_logs').insert([{
                tenant_id: tenantId,
                symbol: rawSymbol, strategy_id: strategyId, version: version, side: side, order_type: orderType, 
                entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
                exit_time: null
            }]).select();
            if (insertError) throw new Error(`Supabase Pre-Insert Error: ${insertError.message}`);
            pendingTradeId = insertData[0].id;
        } catch (error) {
            console.error("[SUPABASE ERROR] Failed to insert trade_log after order:", error.message);
            // Don't throw — order already succeeded, just log
        }
      }

      if (result.success_response?.average_price) {
          executionPrice = parseFloat(result.success_response.average_price);
      } else if (orderType === 'MARKET') {
          const orderId = result.success_response?.order_id;
          if (orderId) {
              console.log(`[EXECUTION SYNC] Awaiting definitive fill price from exchange...`);
              // Retry up to 3 times with increasing delays to get the fill price
              for (let retry = 0; retry < 3; retry++) {
                  await new Promise(resolve => setTimeout(resolve, 1000 + retry * 1000));
                  try {
                      const checkPath = `/api/v3/brokerage/orders/historical/${orderId}`;
                      const checkResp = await fetch(`https://api.coinbase.com${checkPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', checkPath)}` } });
                      if (checkResp.ok) {
                          const checkData = await checkResp.json();
                          if (checkData.order?.average_filled_price) {
                              executionPrice = parseFloat(checkData.order.average_filled_price);
                              console.log(`[EXECUTION SYNC] Confirmed fill price (attempt ${retry + 1}): $${executionPrice}`);
                              break;
                          }
                      }
                  } catch(e) { console.error(`[EXECUTION SYNC] Retry ${retry + 1} failed:`, e.message); }
              }
          } else {
              console.log(`[EXECUTION SYNC] No order_id returned. Cannot refetch fill price.`);
          }
      }

      // 🟢 THE FIX V2: For closing orders, unconditionally use the trade's SL price as fallback
      // when the retry loop couldn't get a real fill price. The old guard (!executionPrice || isNaN...)
      // would never trigger because executionPrice is pre-seeded with incomingPrice (non-zero).
      if (isClosing && openTrade?.sl_price && (!executionPrice || isNaN(executionPrice) || executionPrice === 0 || executionPrice === incomingPrice)) {
          console.log(`[EXECUTION SYNC] Using open trade SL price as fill fallback for close: $${openTrade.sl_price}`);
          executionPrice = parseFloat(openTrade.sl_price);
      }

      // 🟢 THE FIX 2: Strict Fallback to prevent $0 exits from entering the database (only for non-closing orders)
      if (!isClosing && (!executionPrice || isNaN(executionPrice) || executionPrice === 0)) {
          const fallback = incomingPrice || (recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].close : 0);
          console.log(`[EXECUTION SYNC] API returned empty fill price. Using safe fallback: $${fallback}`);
          executionPrice = fallback;
      }

      if (pendingTradeId) {
          try {
              await supabase.from('trade_logs').update({ entry_price: executionPrice }).eq('id', pendingTradeId);
          } catch (updateError) {
              console.error("[SUPABASE ERROR] Failed to update trade_log entry_price:", updateError.message);
          }
      }

      if (!isClosing && orderType === 'MARKET' && tpPrice && slPrice) {
          const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
          
          console.log(`[EXECUTION BREATH] Primary market order filled. Pausing 1.5s before deploying OCO brackets to prevent position size rejection...`);
          await new Promise(resolve => setTimeout(resolve, 1500));

          let actualQty = orderQty;
          try {
              const posPath = '/api/v3/brokerage/cfm/positions';
              const posResp = await fetch(`https://api.coinbase.com${posPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', posPath)}` } });
              if (posResp.ok) {
                  const posData = await posResp.json();
                  const position = posData.positions?.find(p => p.product_id === coinbaseProduct);
                  if (position && Math.abs(parseFloat(position.number_of_contracts)) > 0) {
                      actualQty = Math.abs(parseFloat(position.number_of_contracts));
                      console.log(`[EXECUTION SYNC] Verified actual open position size: ${actualQty}`);
                  }
              }
          } catch(e) { console.error("[EXECUTION SYNC] Position fetch failed:", e.message); }

          if (actualQty !== orderQty && pendingTradeId) {
              try {
                  await supabase.from('trade_logs').update({ qty: actualQty }).eq('id', pendingTradeId);
                  orderQty = actualQty;
              } catch (updateQtyError) {
                  console.error("[SUPABASE ERROR] Failed to update trade_log quantity:", updateQtyError.message);
              }
          }

          try {
              const ocoPayload = {
                  client_order_id: `nx_oco_${pendingTradeId}`, product_id: coinbaseProduct, side: closingSide,
                  order_configuration: { trigger_bracket_gtc: { limit_price: tpPrice.toString(), stop_trigger_price: slPrice.toString(), base_size: actualQty.toString() } }
              };
              const ocoResp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${generateToken('POST', path)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ocoPayload) });
              const ocoResult = await ocoResp.json();
              if (!ocoResp.ok || ocoResult.success === false) {
                  const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
                  console.error(`[BRACKET REJECT] OCO Failed:`, ocoErrMsg);
                  await sendDiscordAlert(tenantId, { title: `⚠️ Bracket Failed: ${rawSymbol}`, description: `**Action:** Missing TP/SL protection!\n**Details:** ${ocoErrMsg}`, color: 15548997 });
              } else {
                  await sendDiscordAlert(tenantId, { title: `🎯 Brackets Deployed: ${rawSymbol}`, description: `**Take Profit:** $${tpPrice}\n**Stop Loss:** $${slPrice}\n**Status:** Active on Exchange`, color: 10181046 }); 
              }
          } catch (e) { console.error("[BRACKET FATAL] OCO failed:", e.message); }
      }
    }

    // 🟢 PAPER TRADE: Create trade_log without Coinbase API (risk check only)
    if (isPaper && !isClosing && !isForcedExit) {
        console.log(`[EXECUTE] Opening new ${side} PAPER position for ${rawSymbol}...`);

        // 🔒 RISK VALIDATOR: Check if trade complies with tenant risk profile
        const riskCheck = await validateTradeRisk(tenantId, {
            side, symbol: rawSymbol,
            entryPrice: executionPrice,
            slPrice: slPrice,
            tpPrice: tpPrice,
            qty: orderQty,
            leverage: leverage
        });

        if (!riskCheck.approved) {
            console.warn(`[EXECUTE] PAPER trade blocked by risk validator: ${riskCheck.reason}`);
            return { status: "risk_vetoed", reason: riskCheck.reason, product: coinbaseProduct };
        }

        if (riskCheck.clamped_sl !== null) slPrice = riskCheck.clamped_sl;
        if (riskCheck.clamped_qty !== null) orderQty = riskCheck.clamped_qty;

        try {
            const { data: insertData } = await supabase.from('trade_logs').insert([{
                tenant_id: tenantId,
                symbol: rawSymbol, strategy_id: strategyId, version: version, side: side, order_type: orderType, 
                entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
                exit_time: null
            }]).select();
            pendingTradeId = insertData[0].id;
        } catch (error) {
            console.error("[SUPABASE ERROR] Failed to insert PAPER trade_log:", error.message);
            throw error;
        }
    }

    const chartUrl = await buildRadarChartUrl({
        asset: rawSymbol, candles: recentCandles, currentPrice: executionPrice,
        poc: telemetry.macro_poc, upperNode: telemetry.upper_macro_node, lowerNode: telemetry.lower_macro_node,
        tpPrice: tpPrice, slPrice: slPrice,
        openTrade: openTrade 
    });

    if (openTrade) {
      if (isClosing) {
        const safeEntryPrice = parseFloat(openTrade.entry_price) || 0;
        const safeExitPrice = parseFloat(executionPrice) || 0;
        const pnl = openTrade.side === 'BUY' ? (safeExitPrice - safeEntryPrice) * orderQty * multiplier : (safeEntryPrice - safeExitPrice) * orderQty * multiplier;
        const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${tradeReason || 'MANUAL_CLOSE'}` : (tradeReason || 'MANUAL_CLOSE');

        try {
            const { error: updateError } = await supabase.from('trade_logs').update({ exit_price: safeExitPrice, pnl: parseFloat(pnl.toFixed(4)), exit_time: new Date().toISOString(), reason: updatedReason }).eq('id', openTrade.id);
            
            if (updateError) {
                console.error("[SUPABASE ERROR] TRADE LOG UPDATE FAILED:", updateError.message);
            } else {
                try {
                    await supabase.from('scan_results').insert([{ strategy: strategyId, asset: rawSymbol, status: 'CLOSED', telemetry: { macro_regime_oracle: `AGENT CLOSED POSITION`, oracle_reasoning: updatedReason, open_pnl: pnl.toFixed(4), open_position: "NONE" } }]);
                } catch (insertScanError) {
                    console.error("[SUPABASE ERROR] Failed to insert scan_results on trade close:", insertScanError.message);
                }
            }
        } catch (outerUpdateError) {
            console.error("[SUPABASE ERROR] Outer trade_logs update failed on close:", outerUpdateError.message);
        }

        executionStatus = 'closed_position';
        
        try {
            await supabase.from('strategy_config').update({
                trap_side: null,
                trap_price: null,
                trap_expires_at: null
            }).eq('strategy', strategyId).eq('asset', rawSymbol);
        } catch (updateConfigError) {
            console.error("[SUPABASE ERROR] Failed to update strategy_config on trade close:", updateConfigError.message);
        }

        const entryText = openTrade.entry_price ? `\n**Entry Price:** $${openTrade.entry_price}` : '';
        const tpText = openTrade.tp_price ? `\n**Target TP:** $${openTrade.tp_price}` : '';
        const slText = openTrade.sl_price ? `\n**Target SL:** $${openTrade.sl_price}` : '';

        await sendDiscordAlert(tenantId, {
            title: `🏁 Position Closed: ${rawSymbol}`, 
            description: `**Exit Price:** $${safeExitPrice}\n**Realized PnL:** $${pnl.toFixed(4)}${entryText}${tpText}${slText}\n**Trigger:** ${tradeReason || 'Signal Reversal'}`, 
            color: pnl >= 0 ? 5763719 : 15548997,
            fields: standardFields,
            imageUrl: chartUrl
        });

      } else {
        return { status: "ignored_already_open", product: coinbaseProduct }; 
      }
    } else {
      const rationaleText = tradeReason ? `\n\n**🧠 Oracle Rationale:**\n_${tradeReason}_` : '';
      let actionTitle = orderType === 'LIMIT' ? `⏳ Limit Order Placed: ${rawSymbol}` : `🚀 New Position Opened: ${rawSymbol}`;
      
      if (tradeReason?.includes('[VIRTUAL TRAP SPRUNG]')) {
          actionTitle = `⚡ Lightning Trap Sprung: ${rawSymbol}`;
      }

      const targetText = (tpPrice && slPrice) ? `\n**Target TP:** $${tpPrice}\n**Target SL:** $${slPrice}` : `\n**Targets:** Dynamic`;

      await sendDiscordAlert(tenantId, {
          title: actionTitle, 
          description: `**Side:** ${side}\n**Entry Price:** $${executionPrice}\n**Qty:** ${orderQty}\n**Mode:** ${mode}${targetText}${rationaleText}`, 
          color: 3447003,
          fields: standardFields,
          imageUrl: chartUrl
      }); 
    }

    if (data.working_thesis) {
        try {
            await supabase.from('strategy_config')
                .update({ active_thesis: data.working_thesis })
                .eq('strategy', strategyId)
                .eq('asset', rawSymbol);
        } catch (updateThesisError) {
            console.error("[SUPABASE ERROR] Failed to update strategy_config active_thesis:", updateThesisError.message);
        }
    }

    return { status: executionStatus, product: coinbaseProduct, price: executionPrice }; 

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    const faultTenantId = data.tenant_id;
    if (faultTenantId) {
        await sendDiscordAlert(faultTenantId, { title: "❌ Execution Fault", description: `**Error:** ${err.message}`, color: 15548997 });
    }
    return { error: err.message }; 
  }
}