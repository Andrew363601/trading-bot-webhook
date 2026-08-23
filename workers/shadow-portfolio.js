// CORRECTED v2 — fetches direction/price/regime from PAIRED SIGNAL SCAN
// (not from oracle_reasoning text which causes direction misclassification)
//
// DB-VALIDATED FIXES:
//   1. Signal direction from signal scan MARKET_STATE ("RESONANT (LONG)" → BUY)
//      NOT from text matching "sell"/"sell" in oracle_reasoning ❌
//   2. Price from signal scan CURRENT_PRICE (clean numeric)
//      NOT from regex extracting scattered $XXX.XX prices from text ❌
//   3. Regime from signal scan macro_regime_oracle
//      NOT from VETO telemetry which shows "AGENT VETO" ❌
//   4. Trade linkage via chronological query
//      Finds the FIRST closed trade AFTER the VETO on same asset within 24h
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
function getSpotSymbol(symbol) {
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
}

/**
 * Fetches 5-min candles from public Coinbase exchange API.
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
 * Extracts signal direction from the PAIRED SIGNAL SCAN's MARKET_STATE.
 * The signal scan stores MARKET_STATE like "RESONANT (LONG)" or "RESONANT (SHORT)".
 * Fallback: infer from oracle_reasoning text (for edge cases with no signal scan).
 */
function inferSignalDirection(marketState, oracleReasoning) {
  // 🥇 Source of truth: signal scan MARKET_STATE
  if (marketState) {
    const upper = marketState.toUpperCase();
    if (upper.includes('LONG') || upper.includes('BUY')) return 'BUY';
    if (upper.includes('SHORT') || upper.includes('SELL')) return 'SELL';
  }
  // Fallback: oracle_reasoning text (less reliable — veto reasons often describe selling pressure)
  if (oracleReasoning) {
    const text = oracleReasoning.toLowerCase();
    // Only match explicit short/sell language, not descriptive "selling pressure"
    if (text.includes('short') && !text.includes('not short') && !text.includes('avoid short')) return 'SELL';
  }
  // Default: most signals on ETP are BUY (wld_trend_v1, coherence_v1 fire longs)
  return 'BUY';
}

/**
 * Fetches the paired signal scan for a VETO scan.
 * The signal scan is the HERMES_NOTIFIED scan with the highest id < veto.id
 * for the same asset. It contains CURRENT_PRICE, macro_regime_oracle, MACRO_STATE.
 */
async function fetchPairedSignal(vetoScanId, asset) {
  try {
    const { data: signals } = await supabase
      .from('scan_results')
      .select('id, telemetry, created_at')
      .eq('asset', asset)
      .eq('status', 'HERMES_NOTIFIED')
      .lt('id', vetoScanId)
      .order('id', { ascending: false })
      .limit(1);

    if (signals && signals.length > 0) {
      const t = signals[0].telemetry || {};
      return {
        id: signals[0].id,
        price: t.CURRENT_PRICE || null,
        regime: t.macro_regime_oracle || null,
        marketState: t.MARKET_STATE || null,
        signalTime: signals[0].created_at
      };
    }
  } catch (e) {
    console.error(`[SHADOW] Paired signal fetch failed for scan ${vetoScanId}:`, e.message);
  }
  return null;
}

/**
 * Extracts conviction score from VETO scan telemetry or reasoning text.
 */
function extractConvictionScore(telemetry, oracleReasoning) {
  if (telemetry?.conviction_score !== undefined && telemetry?.conviction_score !== null) {
    return parseInt(telemetry.conviction_score, 10);
  }
  if (oracleReasoning) {
    const match = oracleReasoning.match(/(?:score|conviction)[:\s]+(\d{1,3})/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Determines the verdict for a VETO based on the subsequent trade outcome.
 * signalDirection: the ORIGINAL signal direction (e.g. BUY for a long signal)
 * trade: the trade_logs row that followed
 * vetoPrice: price at veto time
 */
function determineVerdict(signalDirection, trade, vetoPrice) {
  const tradeIsBuy = (trade.side === 'BUY' || trade.side === 'LONG');
  const tradePnl = parseFloat(trade.pnl || 0);
  const tradeMadeMoney = tradePnl > 0;

  if (signalDirection === 'BUY') {
    if (tradeIsBuy) {
      // VETO was against a BUY signal, trader bought anyway
      if (tradeMadeMoney) return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      else return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
    } else {
      // VETO was against BUY, trader shorted instead (contrarian)
      if (tradeMadeMoney) return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      else return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
    }
  } else {
    // signalDirection is SELL
    if (!tradeIsBuy) {
      if (tradeMadeMoney) return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
      else return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
    } else {
      if (tradeMadeMoney) return { verdict: 'SAVED', saved: Math.abs(tradePnl), missed: 0 };
      else return { verdict: 'MISSED', saved: 0, missed: Math.abs(tradePnl) };
    }
  }
}

let active = false;

async function processUnlabeledVetos() {
  if (active) return;
  active = true;

  try {
    const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h window

    // 1. Find VETO scans not yet labeled
    const { data: vetos, error } = await supabase
      .from('scan_results')
      .select('id, tenant_id, asset, strategy, telemetry, status, created_at')
      .eq('status', 'VETO')
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

      // 🥇 Fetch paired signal scan for direction, price, regime
      const signal = await fetchPairedSignal(scan.id, asset);

      let vetoPrice = signal?.price || null;
      let vetoRegime = signal?.regime || null;
      const signalDirection = inferSignalDirection(signal?.marketState, oracleReasoning);
      const convictionScore = extractConvictionScore(telemetry, oracleReasoning);

      // Fallback: extract price from oracle_reasoning text if no signal scan found
      if (!vetoPrice) {
        const match = oracleReasoning.match(/\$(\d+\.?\d*)/);
        vetoPrice = match ? parseFloat(match[1]) : null;
      }

      // 3. Find nearest closed trade on same asset AFTER veto (within 48h)
      const vetoEnd = new Date(new Date(vetoTime).getTime() + 48 * 3600 * 1000).toISOString();
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('id, side, entry_price, exit_price, pnl, strategy_id, execution_mode, created_at')
        .eq('symbol', asset)
        .not('exit_price', 'is', null)
        .gte('created_at', vetoTime)
        .lt('created_at', vetoEnd)
        .order('created_at', { ascending: true })
        .limit(5);

      let matchingTrade = null;
      if (trades && trades.length > 0) {
        // Prefer same strategy, otherwise use first trade
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
        const priceForCalc = vetoPrice || entryPrice * 0.995;
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
              cDirection = 'WENT_WITH';
              verdict = 'MISSED';
              missedAmount = Math.abs(candles.high - vetoPrice);
            } else if (priceChange < -0.5) {
              cDirection = 'WENT_AGAINST';
              verdict = 'SAVED';
              savedAmount = Math.abs(vetoPrice - candles.low);
            } else {
              cDirection = 'FLAT';
              verdict = 'NEUTRAL';
            }
          } else {
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
        const amount = savedAmount > 0 ? `SAVED $${savedAmount.toFixed(2)}` : missedAmount > 0 ? `MISSED $${missedAmount.toFixed(2)}` : 'NEUTRAL';
        console.log(`[SHADOW] ✅ ${asset} VETO ${scan.id} @ ${vetoTime}: ${signalDirection} → ${verdict} (${amount})`);
      }
    }
  } catch (e) {
    console.error('[SHADOW] Fatal:', e.message);
  } finally {
    active = false;
  }
}

export function startShadowPortfolio() {
  console.log('[SHADOW] v2 Shadow Portfolio worker starting (corrected signal direction)...');

  processUnlabeledVetos();

  setInterval(() => {
    processUnlabeledVetos();
  }, 5 * 60 * 1000);

  console.log('[SHADOW] v2 worker active (5 min interval).');
}