// workers/shadow-portfolio.js
// Runs every 5 minutes. Finds VETO scan_results with no shadow_portfolio entry,
// matches them against closed trades or price action, and labels them.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

// Fetch OHLCV candles from public Coinbase API
async function fetchCoinbaseCandles(symbol, startTime, hoursAfter = 6) {
  try {
    const baseAsset = symbol.split('-')[0].toUpperCase();
    const spotMap = { 'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 'DOP': 'DOGE', 'LCP': 'LTC', 'AVP': 'AVAX', 'LNP': 'LINK', 'XPP': 'XRP' };
    const spotBase = spotMap[baseAsset] || baseAsset;

    const start = Math.floor(new Date(startTime).getTime() / 1000);
    const end = start + (hoursAfter * 3600);

    const resp = await fetch(`https://api.exchange.coinbase.com/products/${spotBase}-USD/candles?start=${start}&end=${end}&granularity=300`);
    if (!resp.ok) return null;

    const candles = await resp.json();
    if (!candles || !Array.isArray(candles) || candles.length === 0) return null;

    // Return high/low across the window
    let high = -Infinity, low = Infinity, firstClose = null, lastClose = null;
    const sorted = candles.sort((a, b) => a[0] - b[0]);
    sorted.forEach(c => {
      high = Math.max(high, c[2]);
      low = Math.min(low, c[1]);
      if (firstClose === null) firstClose = c[4];
      lastClose = c[4];
    });

    return { high, low, firstClose, lastClose };
  } catch (e) {
    console.error(`[SHADOW] Candle fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

async function processUnlabeledVetos() {
  const startTime = new Date();
  startTime.setHours(startTime.getHours() - 24);
  const startISO = startTime.toISOString();

  try {
    // 1. Find all HANDED_TO_AGENT scans in last 24h not yet labeled
    const { data: vetos, error } = await supabase
      .from('scan_results')
      .select('id, tenant_id, asset, strategy, telemetry, status, created_at')
      .in('status', ['HANDED_TO_AGENT', 'HANDED TO AGENT', 'HANDED_OFF', 'VETO'])
      .gte('created_at', startISO)
      .order('created_at', { ascending: true });

    if (error) { console.error('[SHADOW] Query failed:', error.message); return; }
    if (!vetos || vetos.length === 0) { console.log('[SHADOW] No unlabeled vetos found in last 24h.'); return; }

    // Check which ones already have shadow_portfolio entries
    const scanIds = vetos.map(v => v.id);
    const { data: existing } = await supabase
      .from('shadow_portfolio')
      .select('scan_id')
      .in('scan_id', scanIds);

    const labeledScanIds = new Set((existing || []).map(e => e.scan_id));
    const unlabeledVetos = vetos.filter(v => !labeledScanIds.has(v.id));

    if (unlabeledVetos.length === 0) { console.log('[SHADOW] All vetos already labeled.'); return; }

    console.log(`[SHADOW] Processing ${unlabeledVetos.length} unlabeled veto(s)...`);

    for (const scan of unlabeledVetos) {
      const asset = scan.asset;
      const vetoTime = scan.created_at;
      const telemetry = scan.telemetry || {};
      const statusText = (scan.status || '').toUpperCase();

      // Determine signal direction from telemetry or status text
      let signalDirection = 'BUY';
      const reasonText = (telemetry.oracle_reasoning || '').toLowerCase();
      if (reasonText.includes('sell') || reasonText.includes('short')) {
        signalDirection = 'SELL';
      }

      // Extract conviction score from oracle_reasoning if available
      let convictionScore = null;
      // VETO decisions don't store conviction in scan_results telemetry directly
      // We'll get it from the oracle_reasoning or leave null

      // Determine regime from telemetry
      const vetoRegime = telemetry.macro_regime_oracle || telemetry.macro_regime || null;
      const vetoPrice = telemetry.last_price || telemetry.current_price || null;

      // 2. Find closest closed trade on same asset AFTER the veto
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('id, side, entry_price, exit_price, pnl, strategy_id, created_at')
        .eq('symbol', asset)
        .not('exit_price', 'is', null)
        .gte('created_at', vetoTime)
        .lt('created_at', new Date(new Date(vetoTime).getTime() + 24 * 3600 * 1000).toISOString())
        .order('created_at', { ascending: true })
        .limit(5);

      let matchingTrade = null;
      if (trades && trades.length > 0) {
        // Prefer same strategy, otherwise use any
        matchingTrade = trades.find(t => t.strategy_id === scan.strategy) || trades[0];
      }

      let verdict = 'NEUTRAL';
      let savedAmount = 0;
      let missedAmount = 0;
      let actualMovePct = null;
      let entryToExitPnl = null;
      let durationMinutes = null;
      let tradeLogId = null;
      let cLow = null, cHigh = null, cDirection = null;

      if (matchingTrade && matchingTrade.entry_price) {
        // VETO was followed by a real trade
        tradeLogId = matchingTrade.id;
        actualMovePct = ((matchingTrade.entry_price - vetoPrice) / vetoPrice) * 100;
        durationMinutes = Math.round((new Date(matchingTrade.created_at).getTime() - new Date(vetoTime).getTime()) / 60000);
        entryToExitPnl = matchingTrade.pnl;

        const priceWentUp = matchingTrade.entry_price > vetoPrice;
        const tradeIsBuy = matchingTrade.side === 'BUY' || matchingTrade.side === 'LONG';
        const tradeMadeProfit = (matchingTrade.pnl || 0) > 0;

        if (signalDirection === 'BUY') {
          if (tradeIsBuy) {
            if (tradeMadeProfit) {
              verdict = 'MISSED'; // VETO was wrong — price went up, profit was there
              missedAmount = matchingTrade.pnl;
            } else {
              verdict = 'SAVED'; // VETO was right — price went down
              savedAmount = Math.abs(matchingTrade.pnl);
            }
          } else {
            // Signal was BUY but trader shorted (contrarian)
            if (tradeMadeProfit) {
              verdict = 'SAVED'; // Shorting was profitable — VETO against buy was smart
              savedAmount = matchingTrade.pnl;
            } else {
              verdict = 'MISSED';
              missedAmount = Math.abs(matchingTrade.pnl);
            }
          }
        } else {
          // signalDirection is SELL — inverse logic
          if (!tradeIsBuy) {
            if (tradeMadeProfit) {
              verdict = 'MISSED';
              missedAmount = matchingTrade.pnl;
            } else {
              verdict = 'SAVED';
              savedAmount = Math.abs(matchingTrade.pnl);
            }
          } else {
            if (tradeMadeProfit) {
              verdict = 'SAVED';
              savedAmount = matchingTrade.pnl;
            } else {
              verdict = 'MISSED';
              missedAmount = Math.abs(matchingTrade.pnl);
            }
          }
        }
      } else {
        // No trade followed — use counterfactual candle data
        const candles = await fetchCoinbaseCandles(asset, vetoTime, 6);
        if (candles) {
          cLow = candles.low;
          cHigh = candles.high;
          const priceChange = ((candles.lastClose - candles.firstClose) / candles.firstClose) * 100;

          if (signalDirection === 'BUY') {
            if (priceChange > 0.5) {
              cDirection = 'WENT_WITH'; // Price went up — VETO missed opportunity
              verdict = 'MISSED';
              missedAmount = Math.abs(candles.high - vetoPrice);
            } else if (priceChange < -0.5) {
              cDirection = 'WENT_AGAINST'; // Price dropped — VETO saved loss
              verdict = 'SAVED';
              savedAmount = Math.abs(vetoPrice - candles.low);
            } else {
              cDirection = 'FLAT';
              verdict = 'NEUTRAL';
            }
          } else {
            // signalDirection is SELL
            if (priceChange < -0.5) {
              cDirection = 'WENT_WITH';
              verdict = 'MISSED';
              missedAmount = Math.abs(candles.low - vetoPrice);
            } else if (priceChange > 0.5) {
              cDirection = 'WENT_AGAINST';
              verdict = 'SAVED';
              savedAmount = Math.abs(candles.high - vetoPrice);
            } else {
              cDirection = 'FLAT';
              verdict = 'NEUTRAL';
            }
          }

          entryToExitPnl = signalDirection === 'BUY'
            ? candles.lastClose - vetoPrice
            : vetoPrice - candles.lastClose;
        }
      }

      // 3. Write shadow_portfolio record
      const { error: insertError } = await supabase
        .from('shadow_portfolio')
        .insert([{
          tenant_id: scan.tenant_id,
          scan_id: scan.id,
          asset: asset,
          signal_direction: signalDirection,
          conviction_score: convictionScore,
          veto_price: vetoPrice,
          veto_time: vetoTime,
          veto_regime: vetoRegime,
          trade_log_id: tradeLogId,
          verdict: verdict,
          saved_amount: parseFloat(savedAmount.toFixed(4)),
          missed_amount: parseFloat(missedAmount.toFixed(4)),
          actual_move_pct: actualMovePct ? parseFloat(actualMovePct.toFixed(2)) : null,
          entry_to_exit_pnl: entryToExitPnl ? parseFloat(entryToExitPnl.toFixed(4)) : null,
          duration_minutes: durationMinutes,
          counterfactual_low: cLow,
          counterfactual_high: cHigh,
          counterfactual_direction: cDirection
        }]);

      if (insertError) {
        console.error(`[SHADOW] Failed to insert label for scan ${scan.id}:`, insertError.message);
      } else {
        console.log(`[SHADOW] ✅ Labeled veto ${scan.id} on ${asset}: ${verdict} (saved: $${savedAmount.toFixed(2)}, missed: $${missedAmount.toFixed(2)})`);
      }
    }
  } catch (e) {
    console.error('[SHADOW] Fatal error:', e.message);
  }
}

// Start the worker loop
export function startShadowPortfolio() {
  console.log('[SHADOW] Shadow Portfolio worker starting...');

  // Run immediately on start
  processUnlabeledVetos();

  // Then every 5 minutes
  setInterval(() => {
    processUnlabeledVetos();
  }, 5 * 60 * 1000);

  console.log('[SHADOW] Shadow Portfolio worker active (5 min interval).');
}
