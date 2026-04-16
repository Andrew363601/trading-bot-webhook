// Unleashing Vercel Pro limit (5 full minutes) for mass strategy scanning
export const maxDuration = 300;

// pages/api/scan.js
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { evaluateStrategy } from '../../lib/strategy-router.js';
import { evaluateTradeIdea } from '../../lib/trade-oracle.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper function for the Watchdog to sign Coinbase API requests
function generateCoinbaseToken(method, path, apiKey, apiSecret) {
  const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });
  const uriPath = path.split('?')[0]; 
  return jwt.sign(
      { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
      privateKey,
      { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
  );
}

export default async function handler(req, res) {
  try {
    const results = [];
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    const { data: activeConfigs, error: configErr } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('is_active', true);

    if (configErr) throw new Error(configErr.message);
    if (!activeConfigs || activeConfigs.length === 0) {
        return res.status(200).json({ status: "No active strategies to scan." });
    }

    for (const config of activeConfigs) {
      const asset = config.asset;
      if (!asset) continue;

      try {
        const macroTf = config.parameters?.macro_tf || 'ONE_HOUR';
        const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';

        const [macroCandles, triggerCandles] = await Promise.all([
          fetchCoinbaseData(asset, macroTf, apiKeyName, apiSecret),
          fetchCoinbaseData(asset, triggerTf, apiKeyName, apiSecret)
        ]);

        if (!macroCandles || !triggerCandles || macroCandles.length < 21 || triggerCandles.length < 21) continue;
        const currentPrice = triggerCandles[triggerCandles.length - 1].close;

        // FETCH OPEN TRADES
        const { data: openTrades } = await supabase
            .from('trade_logs')
            .select('*')
            .eq('symbol', asset)
            .eq('strategy_id', config.strategy)
            .is('exit_price', null)
            .order('id', { ascending: false })
            .limit(1);
        
        const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;
        let forcedExit = null;

        // --- SCOPE LIFT FOR PRE-EMPTIVE SWEEP ---
        let activePosition = null;
        let openOrders = [];

        // --- THE WATCHDOG, SWEEPER & NATIVE SYNC ---
        if (openTrade) {
            let coinbaseProduct = asset.toUpperCase().trim();
            if (!coinbaseProduct.includes('-')) {
                if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP');
            }

            if (config.execution_mode === 'LIVE') {
                try {
                    const posPath = '/api/v3/brokerage/cfm/positions';
                    const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
                    
                    const [posResp, orderResp] = await Promise.all([
                        fetch(`https://api.coinbase.com${posPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', posPath, apiKeyName, apiSecret)}` } }),
                        fetch(`https://api.coinbase.com${orderPath}`, { headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', orderPath, apiKeyName, apiSecret)}` } })
                    ]);

                    if (posResp.ok) {
                        const posData = await posResp.json();
                        activePosition = posData.positions?.find(p => p.product_id === coinbaseProduct && parseFloat(p.number_of_contracts) > 0);
                    }
                    if (orderResp.ok) {
                        const orderData = await orderResp.json();
                        openOrders = orderData.orders || [];
                    }

                    const entryOrderExists = openOrders.some(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));

                    // SCENARIO 0: Native Exchange Sync
                    if (!activePosition && !entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        if (minutesOpen > 2) {
                            console.log(`[SYNC] Trade ${openTrade.id} missing from Coinbase. Syncing native close...`);
                            
                            if (openOrders.length > 0) {
                                console.log(`[SWEEPER] Nuking ${openOrders.length} orphaned brackets for ${coinbaseProduct} to prevent Phantom Flips...`);
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, {
                                    method: 'POST', 
                                    headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, 
                                    body: JSON.stringify({ order_ids: openOrders.map(o => o.order_id) })
                                });
                            }

                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: EXCHANGE_NATIVE_CLOSE` : 'EXCHANGE_NATIVE_CLOSE';
                            await supabase.from('trade_logs').update({
                                exit_price: currentPrice, 
                                pnl: (openTrade.side === 'BUY' ? currentPrice - openTrade.entry_price : openTrade.entry_price - currentPrice) * openTrade.qty,
                                exit_time: new Date().toISOString(),
                                reason: updatedReason
                            }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO A: Stale Limit Sweeper
                    if (!activePosition && entryOrderExists) {
                        const minutesOpen = (Date.now() - new Date(openTrade.created_at).getTime()) / 60000;
                        
                        if (minutesOpen > 15) {
                            console.log(`[SWEEPER] Stale limit order detected for ${coinbaseProduct} (${minutesOpen.toFixed(1)} mins old). Canceling...`);
                            
                            const targetOrder = openOrders.find(o => o.side === openTrade.side && parseFloat(o.order_configuration?.limit_limit_gtc?.limit_price) === parseFloat(openTrade.entry_price));
                            
                            if (targetOrder) {
                                const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                                await fetch(`https://api.coinbase.com${cancelPath}`, {
                                    method: 'POST', headers: { 'Authorization': `Bearer ${generateCoinbaseToken('POST', cancelPath, apiKeyName, apiSecret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_ids: [targetOrder.order_id] })
                                });
                            }
                            
                            const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: STALE_LIMIT_EXPIRED` : 'STALE_LIMIT_EXPIRED';
                            await supabase.from('trade_logs').update({
                                exit_price: openTrade.entry_price, 
                                pnl: 0,
                                exit_time: new Date().toISOString(),
                                reason: updatedReason
                            }).eq('id', openTrade.id);
                            continue; 
                        }
                    }

                    // SCENARIO B: Bracket Deployment & Manual Sync
                    if (activePosition) {
                        const physicalTP = openOrders.find(o => o.order_configuration?.limit_limit_gtc);
                        const physicalSL = openOrders.find(o => o.order_configuration?.stop_limit_stop_limit_gtc);
                        const physicalBracket = openOrders.find(o => o.order_configuration?.trigger_bracket_gtc);

                        if (physicalBracket && (!openTrade.tp_price || !openTrade.sl_price)) {
                             console.log(`[SYNC] Manual OCO Bracket detected on Coinbase UI for ${asset}. Updating database...`);
                             const updates = {
                                 tp_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.limit_price),
                                 sl_price: parseFloat(physicalBracket.order_configuration.trigger_bracket_gtc.stop_trigger_price)
                             };
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price;
                             openTrade.sl_price = updates.sl_price;
                        } 
                        else if ((physicalTP && !openTrade.tp_price) || (physicalSL && !openTrade.sl_price)) {
                             console.log(`[SYNC] Manual individual brackets detected on Coinbase for ${asset}. Updating database...`);
                             const updates = {};
                             if (physicalTP) updates.tp_price = parseFloat(physicalTP.order_configuration.limit_limit_gtc.limit_price);
                             if (physicalSL) updates.sl_price = parseFloat(physicalSL.order_configuration.stop_limit_stop_limit_gtc.stop_price);
                             
                             await supabase.from('trade_logs').update(updates).eq('id', openTrade.id);
                             openTrade.tp_price = updates.tp_price || openTrade.tp_price;
                             openTrade.sl_price = updates.sl_price || openTrade.sl_price;
                        }

                        const hasTP = physicalBracket || physicalTP;
                        const hasSL = physicalBracket || physicalSL;

                        if (hasTP && hasSL) {
                            openTrade.skipVirtualEnforcer = true;
                        }

                        const closingSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                        const stopDir = openTrade.side === 'BUY' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';
                        const orderQty = activePosition.number_of_contracts;
                        const executePath = '/api/v3/brokerage/orders';

                        let tickSize = 0.01;
                        if (coinbaseProduct.includes('ETP') || coinbaseProduct.includes('ETH')) tickSize = 0.50;
                        if (coinbaseProduct.includes('BIT') || coinbaseProduct.includes('BTC')) tickSize = 1.00;

                        const safeSlPrice = openTrade.sl_price ? (Math.round(openTrade.sl_price / tickSize) * tickSize).toFixed(2) : null;
                        const safeTpPrice = openTrade.tp_price ? (Math.round(openTrade.tp_price / tickSize) * tickSize).toFixed(2) : null;

                        // --- THE ULTIMATE FIX: OCO BRACKET DEPLOYMENT ---
                        // Bypasses the "Double Margin Trap" by sending a unified OCO order instead of separate independent limits.
                        if (!hasTP && !hasSL && safeTpPrice && safeSlPrice) {
                            console.log(`[WATCHDOG] Missing Brackets detected for ${coinbaseProduct}. Deploying Unified OCO (TP: $${safeTpPrice}, SL: $${safeSlPrice})...`);
                            try {
                                const ocoPayload = {
                                    client_order_id: `nx_oco_wd_${Date.now()}`,
                                    product_id: coinbaseProduct,