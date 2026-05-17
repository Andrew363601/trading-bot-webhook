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

/**
 * Ensures the derivatives CFM wallet has sufficient funds before order placement.
 * Transfers USD from primary spot wallet if needed.
 */
async function ensureDerivativesFunds(generateToken, requiredMargin) {
    try {
        // 1. Check current derivatives balance
        const cfmPath = '/api/v3/brokerage/cfm/balance_summary';
        const cfmResp = await fetch(`https://api.coinbase.com${cfmPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', cfmPath)}` }
        });
        if (!cfmResp.ok) {
            console.warn(`[AUTO-FUND] Could not check CFM balance: HTTP ${cfmResp.status}`);
            return { funded: false, reason: 'CFM balance check failed' };
        }

        const cfmData = await cfmResp.json();
        const availableBalance = parseFloat(
            cfmData.balance_summary?.total_balance?.value ||
            cfmData.balance_summary?.total_usd_balance?.value ||
            cfmData.balance_summary?.futures_margin_balance?.value || 0
        );

        if (availableBalance >= requiredMargin) {
            console.log(`[AUTO-FUND] Sufficient derivatives balance: $${availableBalance.toFixed(2)} (need $${requiredMargin.toFixed(2)})`);
            return { funded: true };
        }

        const deficit = requiredMargin - availableBalance;
        console.log(`[AUTO-FUND] Derivatives deficit of $${deficit.toFixed(2)} (balance: $${availableBalance.toFixed(2)}, need: $${requiredMargin.toFixed(2)})`);

        // 2. Check spot USD balance
        const spotPath = '/api/v3/brokerage/accounts';
        const spotResp = await fetch(`https://api.coinbase.com${spotPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', spotPath)}` }
        });
        if (!spotResp.ok) {
            return { funded: false, reason: `Spot balance check failed: HTTP ${spotResp.status}` };
        }

        const spotData = await spotResp.json();
        const usdAccounts = spotData.accounts?.filter(a => a.currency === 'USD' || a.currency === 'USDC') || [];
        const spotBalance = usdAccounts.reduce((sum, acc) => sum + parseFloat(acc.available_balance?.value || 0), 0);

        const transferAmount = Math.min(deficit, spotBalance);
        if (transferAmount <= 0.01) {
            return { funded: false, reason: `Insufficient spot balance. Available: $${spotBalance.toFixed(2)}, Deficit: $${deficit.toFixed(2)}` };
        }

        // 3. Get CFM portfolio UUID
        const portfoliosPath = '/api/v3/brokerage/portfolios';
        const portResp = await fetch(`https://api.coinbase.com${portfoliosPath}`, {
            headers: { 'Authorization': `Bearer ${generateToken('GET', portfoliosPath)}` }
        });
        if (!portResp.ok) {
            return { funded: false, reason: 'Could not fetch portfolio list' };
        }

        const portData = await portResp.json();
        const cfmPortfolio = portData.portfolios?.find(p =>
            p.type === 'FUTURES' || p.name?.toUpperCase().includes('FUTURES') || p.name?.toUpperCase().includes('CFM')
        );
        if (!cfmPortfolio) {
            return { funded: false, reason: 'No CFM futures portfolio found' };
        }

        const portfolioUuid = cfmPortfolio.uuid || cfmPortfolio.portfolio_uuid || cfmPortfolio.id;
        if (!portfolioUuid) {
            return { funded: false, reason: 'CFM portfolio has no UUID' };
        }

        // 4. Transfer from spot into derivatives
        const transferPath = '/api/v3/brokerage/portfolio_transfer';
        const transferResp = await fetch(`https://api.coinbase.com${transferPath}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${generateToken('POST', transferPath)}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                portfolio_uuid: portfolioUuid,
                transfer_type: 'DEPOSIT',
                currency: 'USD',
                amount: transferAmount.toFixed(2)
            })
        });

        if (!transferResp.ok) {
            const transferErr = await transferResp.text();
            console.error(`[AUTO-FUND] Transfer rejected: ${transferErr}`);
            return { funded: false, reason: `Transfer failed: ${transferErr}` };
        }

        console.log(`[AUTO-FUND] Transferred $${transferAmount.toFixed(2)} from spot to derivatives. Waiting 1.5s for propagation...`);
        return { funded: true, amount: transferAmount };

    } catch (e) {
        console.error(`[AUTO-FUND] Error: ${e.message}`);
        return { funded: false, reason: e.message };
    }
}

export async function executeTradeMCP(data) {
  try {
    const tenantId = data.tenant_id;
    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';
    
    let apiKeyName, apiSecret;
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

    const formattedSecret = apiSecret.replace(/\\n/g, '\n');

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
        const end = Math.floor(Date.now() / 1000);
        const start = end - (300 * 50); 
        const candlePath = `/api/v3/brokerage/products/${coinbaseProduct}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE`;
        const token = generateToken('GET', candlePath);
        const candleResp = await fetch(`https://api.coinbase.com${candlePath}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (candleResp.ok) {
            const cData = await candleResp.json();
            recentCandles = cData.candles?.map(c => ({
                open: parseFloat(c.open || c.close), 
                high: parseFloat(c.high), 
                low: parseFloat(c.low), 
                close: parseFloat(c.close)
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

    if (!isClosing && !isForcedExit) {
        console.log(`[EXECUTE] Opening new ${side} position for ${rawSymbol}...`);

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
            console.error(`[RISK VETO] Trade blocked by risk validator: ${riskCheck.reason}`);
            await sendDiscordAlert(tenantId, {
                title: `🛑 Risk Validator Blocked: ${rawSymbol}`,
                description: `**Reason:** ${riskCheck.reason}\n**Side:** ${side}\n**Entry:** $${executionPrice}\n**SL:** $${slPrice}\n**Qty:** ${orderQty}`,
                color: 15548997
            });
            return { status: "risk_vetoed", reason: riskCheck.reason, product: coinbaseProduct };
        }

        // Apply any clamping adjustments from risk validator
        if (riskCheck.clamped_sl !== null) {
            slPrice = riskCheck.clamped_sl;
            console.log(`[RISK CLAMP] SL adjusted from original to $${slPrice} to meet risk budget.`);
        }
        if (riskCheck.clamped_qty !== null) {
            orderQty = riskCheck.clamped_qty;
            console.log(`[RISK CLAMP] Qty adjusted from original to ${orderQty} to meet risk budget.`);
        }

        try {
            const { data: insertData, error: insertError } = await supabase.from('trade_logs').insert([{
                tenant_id: tenantId,
                symbol: rawSymbol, strategy_id: strategyId, version: version, side: side, order_type: orderType, 
                entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason 
            }]).select();
            if (insertError) throw new Error(`Supabase Pre-Insert Error: ${insertError.message}`);
            pendingTradeId = insertData[0].id;
        } catch (error) {
            console.error("[SUPABASE ERROR] Failed to insert new trade_log:", error.message);
            throw error; // Re-throw to halt execution if trade log cannot be created
        }
    }

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

      // 🟢 AUTO-FUND: Ensure derivatives wallet has margin for new LIVE positions
      if (!isClosing && marketType !== 'SPOT') {
          const priceForMargin = executionPrice > 0 ? executionPrice : (incomingPrice > 0 ? incomingPrice : (recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].close : 0));
          // With leverage, margin = notional / leverage
          const estimatedMargin = (orderQty * priceForMargin * Math.abs(multiplier)) / Math.max(leverage, 1);
          if (estimatedMargin > 0) {
              const fundResult = await ensureDerivativesFunds(generateToken, estimatedMargin);
              if (!fundResult.funded) {
                  console.warn(`[AUTO-FUND] Pre-funding check: ${fundResult.reason}. Order will proceed and may fail if insufficient.`);
              } else if (fundResult.amount) {
                  await new Promise(resolve => setTimeout(resolve, 1500));
              }
          }
      }

      const path = '/api/v3/brokerage/orders';
      const token = generateToken('POST', path);
      
      let clientId = isClosing ? `nx_close_${openTrade.id}_${Date.now()}` : `nx_entry_${pendingTradeId}`;
      const payload = {
        client_order_id: clientId, product_id: coinbaseProduct, side: side, order_configuration: {}
      };

      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = { base_size: orderQty.toString(), limit_price: executionPrice.toString() };
      } else {
          payload.order_configuration.market_market_ioc = { base_size: orderQty.toString() };
      }

      let resp = await fetch(`https://api.coinbase.com${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      let result = await resp.json();
      
      // Handle order rejection
      if (!resp.ok || result.success === false || result.error_response) {
        if (pendingTradeId) {
            try {
                await supabase.from('trade_logs').delete().eq('id', pendingTradeId);
            } catch (deleteError) {
                console.error("[SUPABASE ERROR] Failed to delete pending trade_log after Coinbase rejection:", deleteError.message);
            }
        }
        const errMsg = result.error_response?.preview_failure_reason || result.error_response?.error || result.failure_reason?.error_message || JSON.stringify(result);
        throw new Error(`Coinbase Order Rejected: ${errMsg}`);
      }
      
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      if (result.success_response?.average_price) {
          executionPrice = parseFloat(result.success_response.average_price);
      } else if (orderType === 'MARKET') {
          console.log(`[EXECUTION SYNC] Awaiting definitive fill price from exchange...`);
          await new Promise(resolve => setTimeout(resolve, 1500)); 
          
          try {
               const orderId = result.success_response?.order_id;
               if (orderId) {
                   const checkPath = `/api/v3/brokerage/orders/historical/${orderId}`;
                   const checkResp = await fetch(`https://api.coinbase.com${checkPath}`, { headers: { 'Authorization': `Bearer ${generateToken('GET', checkPath)}` } });
                   if (checkResp.ok) {
                       const checkData = await checkResp.json();
                       if (checkData.order?.average_filled_price) {
                           executionPrice = parseFloat(checkData.order.average_filled_price);
                           console.log(`[EXECUTION SYNC] Confirmed fill price: $${executionPrice}`);
                       }
                   }
               }
          } catch(e) { console.error("[EXECUTION SYNC] Failed to retrieve exact fill price.", e.message); }
      }

      // 🟢 THE FIX 2: Strict Fallback to prevent $0 exits from entering the database
      if (!executionPrice || isNaN(executionPrice) || executionPrice === 0) {
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