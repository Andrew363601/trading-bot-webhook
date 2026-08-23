// workers/shadow-portfolio.js
// VALIDATED against actual codebase:
//   - scan_results uses status='VETO' (from hermes-brain.js line 476)
//   - VETO scans have NO price in telemetry (hermes-brain.js lines 481-487)
//   - trade_logs has exit_price, pnl, side, strategy_id columns
//   - Coinbase public API pattern from watchdog.js line 218
//
// Runs every 5 minutes. Finds VETO scan_results with no shadow_portfolio entry,
// matches them against closed trades or price action, and labels them.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

/**
 * Maps asset symbols to their public spot equivalent.
 * Same pattern as watchdog.js getSpotSymbol() (line 70-83).
 */
const getSpotSymbol = (symbol) => {
  const base = symbol.split('-')[0].toUpperCase();
  const spotMap = {
    'ETP': 'ETH', 'ETH': 'ETH',
    'BIT': 'BTC', 'BIP': 'BTC', 'BTC': 'BTC',
    'SLP': 'SOL', 'SOL': 'SOL',
    'DOP': 'DOGE', 'DOGE': 'DOGE',
    'LCP': 'LTC', 'LTC': 'LTC',
    'AVP': 'AVAX', 'AVAX': 'AVAX',
    'LNP': 'LINK', 'LINK': 'LINK',
    'XPP': 'XRP', 'XRP': 'XRP'
  };
  return `${spotMap[base] || base}-USD`;
};

/**
 * Fetches 5-min candles from public Coinbase exchange API.
 * Same unauthenticated pattern as watchdog.js lines 92-100.
 */
async function fetchCounterfactualCandles(symbol, startTime, hours = 6) {
  try {
    const spotSymbol = getSpotSymbol(symbol);
    const start = Math.floor(new Date(startTime).getTime() / 1000);
    const end = start + (hours * 3600);

    const resp = await fetch(
      `https://api.exchange.coinbase.com/products/${spotSymbol}/candles?start=${start}&end=${end}&granularity=300`
    );
    if (!resp.ok) return null;

    const candles = await resp.json();
    if (!candles || !Array.isArray(candles) || candles.length === 0) return null;

    let high = -Infinity, low = Infinity;
    let firstClose = null, lastClose = null;
    const sorted = candles.sort((a, b) => a[0] - b[0]);
    sorted.forEach(c => {
      high = Math.max(high, parseFloat(c[2]));
      low = Math.min(low, parseFloat(c[1]));
      if (firstClose === null) firstClose = parseFloat(c[4]);
      lastClose = parseFloat(c[4]);
    });

    return { high, low, firstClose, lastClose };
  } catch (e) {
    console.error(`[SHADOW] Candle fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

/**
 * Extracts signal direction from the VETO scan's oracle_reasoning text.
 * Defaults to 'BUY' (most signals are buy-side).
 */
function inferSignalDirection(oracleReasoning) {
  if (!oracleReasoning) return 'BUY';
  const text = oracleReasoning.toLowerCase();
  if (text.includes('sell') || text.includes('short') || text.includes('bearish')) {
    return 'SELL';
  }
  return 'BUY';
}

/**
 * Extracts conviction score from VETO scan telemetry or reasoning text.
 */
function extractConvictionScore(telemetry, oracleReasoning) {
  // Check if telemetry has a conviction field directly
  if (telemetry?.conviction_score !== undefined && telemetry?.conviction_score !== null) {
    return parseInt(telemetry.conviction_score, 10);
  }
  // Try regex from oracle_reasoning: "Score: 42" or "conviction: 38"
  if (oracleReasoning) {
    const match = oracleReasoning.match(/(?:score|conviction)[:\s]+(\d{1,3})/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Determines the verdict for a VETO based on the subsequent trade outcome.
 */
function determineVerdict(signalDirection, trade, vetoPrice) {
  const tradeIsBuy = (trade.side === 'BUY' || trade.side === 'LONG');
  const tradePnl = parseFloat(trade.pnl || 0);

  if (signalDirection === 'BUY') {
    if (tradeIsBuy) {
      // VETO was against a BUY signal, trader bought anyway
      if (tradePnl > 0) {
        // Price went up — VETO was wrong, missed profit
        return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      } else {
        // Price went down — VETO was correct, saved loss
        return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      }
    } else {
      // VETO was against BUY, trader shorted instead (contrarian)
      if (tradePnl > 0) {
        // Shorting worked — VETO was smart to not buy
        return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      } else {
        // Shorting failed — VETO didn't help
        return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      }
    }
  } else {
    // signalDirection is SELL
    if (!tradeIsBuy) {
      // VETO was against SELL, trader shorted anyway
      if (tradePnl > 0) {
        return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      } else {
        return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      }
    } else {
      // VETO was against SELL, trader bought instead
      if (tradePnl > 0) {
        return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      } else {
        return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      }
    }
  }
}

let active = false;

async function processUnlabeledVetos() {
  if (active) return; // Prevent concurrent runs
  active = true;

  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // 1. Find VETO scans in last 24h - validated status value from hermes-brain.js line 476
    const { data: vetos, error } = await supabase
      .from('scan_results')
      .select('id, tenant_id, asset, strategy, telemetry, status, created_at')
      .eq('status', 'VETO')                    // ⚡ Correct status value
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });

    if (error) { console.error('[SHADOW] Query failed:', error.message); return; }
    if (!vetos || vetos.length === 0) { return; }

    // 2. Exclude already-labeled scans
    const scanIds = vetos.map(v => v.id);
    const { data: existing } = await supabase
      .from('shadow_portfolio')
      .select('scan_id')
      .in('scan_id', scanIds);

    const labeledIds = new Set((existing || []).map(e => e.scan_id));
    const unlabeled = vetos.filter(v => !labeledIds.has(v.id));

    if (unlabeled.length === 0) { return; }

    console.log(`[SHADOW] Processing ${unlabeled.length} unlabeled veto(s)...`);

    for (const scan of unlabeled) {
      const asset = scan.asset;
      const vetoTime = scan.created_at;
      const telemetry = scan.telemetry || {};
      const oracleReasoning = telemetry.oracle_reasoning || '';

      // ⚠ VETO scan telemetry has NO price and regime shows "AGENT VETO" not the real regime.
      // Fetch the paired signal scan (usually scan.id - 1) to get real data.
      let vetoPrice = null;
      let vetoRegime = null;
      try {
        const { data: pairedSignal } = await supabase
          .from('scan_results')
          .select('telemetry')
          .eq('asset', asset)
          .eq('status', 'HERMES_NOTIFIED')
          .lt('id', scan.id)
          .order('id', { ascending: false })
          .limit(1);

        if (pairedSignal && pairedSignal.length > 0) {
          const signalTelemetry = pairedSignal[0].telemetry || {};
          vetoPrice = signalTelemetry.CURRENT_PRICE || null;
          vetoRegime = signalTelemetry.macro_regime_oracle || null;
        }
      } catch (e) {
        console.error(`[SHADOW] Failed to fetch paired signal for scan ${scan.id}:`, e.message);
      }

      // Fallback: extract price from oracle_reasoning text
      if (!vetoPrice) {
        const priceMatch = oracleReasoning.match(/\$(\d+\.?\d*)/);
        vetoPrice = priceMatch ? parseFloat(priceMatch[1]) : null;
      }

      // Extract signal direction and conviction
      const signalDirection = inferSignalDirection(oracleReasoning);
      const convictionScore = extractConvictionScore(telemetry, oracleReasoning);

      // 3. Find nearest closed trade on same asset AFTER veto
      const vetoEnd = new Date(new Date(vetoTime).getTime() + 24 * 3600 * 1000).toISOString();
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('id, side, entry_price, exit_price, pnl, strategy_id, created_at')
        .eq('symbol', asset)
        .not('exit_price', 'is', null)        // Must be closed
        .gte('created_at', vetoTime)
        .lt('created_at', vetoEnd)
        .order('created_at', { ascending: true })
        .limit(5);

      let matchingTrade = null;
      if (trades && trades.length > 0) {
        matchingTrade = trades.find(t => t.strategy_id === scan.strategy) || trades[0];
      }

      let verdict = 'NEUTRAL';
      let savedAmount = 0, missedAmount = 0;
      let actualMovePct = null, durationMinutes = null;
      let tradeLogId = null, tradeSide = null, tradePnl = null;
      let cLow = null, cHigh = null, cDirection = null;

      if (matchingTrade && matchingTrade.entry_price) {
        tradeLogId = matchingTrade.id;
        tradeSide = matchingTrade.side;
        tradePnl = matchingTrade.pnl;

        const entryPrice = parseFloat(matchingTrade.entry_price);
        const priceForCalc = vetoPrice || entryPrice * 0.995; // fallback
        actualMovePct = ((entryPrice - priceForCalc) / priceForCalc) * 100;
        durationMinutes = Math.round(
          (new Date(matchingTrade.created_at).getTime() - new Date(vetoTime).getTime()) / 60000
        );

        const result = determineVerdict(signalDirection, matchingTrade, priceForCalc);
        verdict = result.verdict;
        savedAmount = result.saved;
        missedAmount = result.missed;
      } else {
        // No trade followed — use counterfactual candle data
        const candles = await fetchCounterfactualCandles(asset, vetoTime, 6);
        if (candles && vetoPrice) {
          cLow = candles.low;
          cHigh = candles.high;
          const priceChange = ((candles.lastClose - candles.firstClose) / candles.firstClose) * 100;

          if (signalDirection === 'BUY') {
            if (priceChange > 0.5) {
              // Price went up → VETO missed opportunity
              cDirection = 'WENT_WITH';
              verdict = 'MISSED';
              missedAmount = Math.abs(candles.high - vetoPrice);
            } else if (priceChange < -0.5) {
              // Price dropped → VETO saved loss
              cDirection = 'WENT_AGAINST';
              verdict = 'SAVED';
              savedAmount = Math.abs(vetoPrice - candles.low);
            } else {
              cDirection = 'FLAT';
              verdict = 'NEUTRAL';
            }
          } else {
            // signalDirection is SELL — inverse
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
        }
      }

      // 4. INSERT shadow_portfolio record
      const { error: insertError } = await supabase
        .from('shadow_portfolio')
        .insert([{
          tenant_id: scan.tenant_id,
          scan_id: scan.id,
          asset,
          signal_direction: signalDirection,
          conviction_score: convictionScore,
          veto_price: vetoPrice ? parseFloat(vetoPrice.toFixed(2)) : null,
          veto_time: vetoTime,
          veto_regime: vetoRegime,
          trade_log_id: tradeLogId,
          trade_side: tradeSide,
          trade_pnl: tradePnl ? parseFloat(tradePnl.toFixed(4)) : null,
          verdict,
          saved_amount: parseFloat(savedAmount.toFixed(4)),
          missed_amount: parseFloat(missedAmount.toFixed(4)),
          actual_move_pct: actualMovePct !== null ? parseFloat(actualMovePct.toFixed(2)) : null,
          duration_minutes: durationMinutes,
          counterfactual_low: cLow !== null ? parseFloat(cLow.toFixed(2)) : null,
          counterfactual_high: cHigh !== null ? parseFloat(cHigh.toFixed(2)) : null,
          counterfactual_direction: cDirection
        }]);

      if (insertError) {
        console.error(`[SHADOW] Insert failed for scan ${scan.id}:`, insertError.message);
      } else {
        console.log(`[SHADOW] ✅ ${scan.asset} VETO @ ${vetoTime}: ${verdict} (saved: $${savedAmount.toFixed(2)}, missed: $${missedAmount.toFixed(2)})`);
      }
    }
  } catch (e) {
    console.error('[SHADOW] Fatal:', e.message);
  } finally {
    active = false;
  }
}

// Named export — matches the pattern of startSniper() and startWatchdog()
export function startShadowPortfolio() {
  console.log('[SHADOW] Shadow Portfolio worker starting...');

  // Run immediately
  processUnlabeledVetos();

  // Then every 5 minutes (matches watchdog interval pattern)
  setInterval(() => {
    processUnlabeledVetos();
  }, 5 * 60 * 1000);

  console.log('[SHADOW] Shadow Portfolio worker active (5 min interval).');
}

