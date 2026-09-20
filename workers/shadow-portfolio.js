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

class ResilientWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    // Transport errors must never kill the worker. Supabase realtime owns
    // reconnection; this listener only prevents the unhandled-'error' crash.
    this.on('error', (err) => {
      console.error('[WS-GUARD] realtime transport error (reconnect owned by supabase):', err.code || err.message);
    });
  }
}

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { retrieveAPIKey } from '../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: ResilientWebSocket }, realtime: { transport: ResilientWebSocket } }
);

// AG2: Discord resolution notification — pattern copied from workers/watchdog.js.
// Silently skips tenants with no webhook configured.
async function sendDiscordAlert(tenant_id, { title, description, color, fields = [], imageUrl = null }) {
    const { data: settings, error: settingsError } = await supabase
        .from('tenant_settings')
        .select('notification_webhook_url')
        .eq('tenant_id', tenant_id)
        .single();

    if (settingsError) {
        console.error("[SHADOW DISCORD ERROR]: Failed to fetch webhook URL for tenant:", settingsError.message);
        return;
    }
    const webhookUrl = settings?.notification_webhook_url;

    if (!webhookUrl) {
        // Silent skip — no webhook configured for this tenant.
        return;
    }
    try {
        const embed = { title, color, timestamp: new Date().toISOString() };
        // Discord embed description hard limit = 4096 chars. Truncation guard
        // copied from watchdog.js to avoid silent 400 rejections.
        let desc = description || '';
        if (desc.length > 3800) {
            desc = desc.slice(0, 2000) + '\n\n…[truncated]…\n\n' + desc.slice(-1600);
        }
        embed.description = desc;
        if (fields.length > 0) embed.fields = fields.filter(f => String(f.value ?? '').length <= 1024);
        if (imageUrl) embed.image = { url: imageUrl };
        const resp = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[SHADOW DISCORD ERROR]: webhook returned ${resp.status}: ${body.slice(0, 200)}`);
        }
    } catch (e) { console.error("[SHADOW DISCORD] Alert Failed:", e.message); }
}

// AG2: fire a resolution embed when a sim resolves SAVED or MISSED (NEUTRAL skipped).
async function notifyShadowResolution(row) {
    try {
        if (row.verdict !== 'SAVED' && row.verdict !== 'MISSED') return;
        // Exit reason labels match runShadowSim's actual outputs (TP/SL/TRAIL/HORIZON/TRIPWIRE).
        const exitReasonMap = {
            'TP': '🎯 Take Profit', 'SL': '🛑 Stop Loss', 'TRAIL': '📉 Trailing SL',
            'TRIPWIRE': '⚡ Tripwire', 'HORIZON': '⏳ 24h Horizon'
        };
        const exitReason = row.sim_exit_reason
            ? (exitReasonMap[row.sim_exit_reason] || row.sim_exit_reason)
            : (row.verdict === 'SAVED' ? '✅ Veto was correct (price moved against signal)' : '❌ Veto was wrong (price moved with signal)');
        const pts = row.sim_pnl_pts != null ? row.sim_pnl_pts.toFixed(2) : (row.saved_amount > 0 ? row.saved_amount.toFixed(2) : row.missed_amount.toFixed(2));
        const entry = row.veto_price != null ? `$${row.veto_price.toFixed(2)}` : '—';
        const exit = row.sim_exit_price != null ? `$${row.sim_exit_price.toFixed(2)}` : '—';
        const pct = row.actual_move_pct != null ? `${row.actual_move_pct > 0 ? '+' : ''}${row.actual_move_pct.toFixed(2)}%` : '—';
        const qtyUsd = row.sim_params?.qty != null ? `$${row.sim_params.qty}` : '$1,000 (default notional)';
        const bars = row.sim_bars != null ? `${row.sim_bars}` : '—';
        const color = row.verdict === 'SAVED' ? 3066993 : 15158332; // green / red
        await sendDiscordAlert(row.tenant_id, {
            title: `🛡️ Shadow trade closed — ${row.verdict}`,
            description: `Counterfactual simulation resolved for a vetoed ${row.asset} signal.`,
            color,
            fields: [
                { name: 'Asset', value: String(row.asset), inline: true },
                { name: 'Direction', value: String(row.signal_direction || '—'), inline: true },
                { name: 'Entry → Exit', value: `${entry} → ${exit}`, inline: true },
                { name: 'Exit Reason', value: String(exitReason), inline: true },
                { name: 'PnL', value: `${pts} pts (${pct} of entry)`, inline: true },
                { name: 'Config Qty', value: qtyUsd, inline: true },
                { name: 'Bars Held', value: bars, inline: true },
                { name: 'Regime', value: String(row.veto_regime || '—'), inline: true }
            ]
        });
    } catch (e) {
        console.error('[SHADOW DISCORD] notifyShadowResolution failed:', e.message);
    }
}

// Cache tenant keys to avoid repeated vault queries
const tenantKeyCache = new Map();

function generateCoinbaseToken(method, path, apiKey, apiSecret) {
    const privateKey = crypto.createPrivateKey({ key: apiSecret.replace(/\\n/g, '\n'), format: 'pem' });
    const uriPath = path.split('?')[0];
    return jwt.sign(
        { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKey, uri: `${method} api.coinbase.com${uriPath}` },
        privateKey, { algorithm: 'ES256', header: { kid: apiKey, nonce: crypto.randomBytes(16).toString('hex') } }
    );
}

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
 * Fetches 5-min candles from authenticated Coinbase CDP API.
 */
async function fetchCounterfactualCandles(symbol, startTime, hours = 6, tenantId = null) {
  try {
    if (!tenantId) return null;
    let apiKey, apiSecret;
    if (tenantKeyCache.has(tenantId)) {
      ({ apiKey, apiSecret } = tenantKeyCache.get(tenantId));
    } else {
      try {
        const keys = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
        apiKey = keys.apiKey;
        apiSecret = keys.apiSecret;
        tenantKeyCache.set(tenantId, { apiKey, apiSecret });
      } catch (e) {
        console.error(`[SHADOW] No exchange keys for tenant ${tenantId}:`, e.message);
        return null;
      }
    }

    const spotSymbol = getSpotSymbol(symbol);
    const start = Math.floor(new Date(startTime).getTime() / 1000);
    const end = start + (hours * 3600);
    const candlePath = `/api/v3/brokerage/products/${spotSymbol}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE`;
    const token = generateCoinbaseToken('GET', candlePath, apiKey, apiSecret);

    const resp = await fetch(`https://api.coinbase.com${candlePath}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const candles = data?.candles;
    if (!candles || !Array.isArray(candles) || candles.length === 0) return null;

    let high = -Infinity, low = Infinity;
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    high = Math.max(...highs);
    low = Math.min(...lows);
    const firstClose = parseFloat(candles[candles.length - 1].close); // OLDEST candle
    const lastClose = parseFloat(candles[0].close); // NEWEST candle

    // AG1 sim engine: normalized chronological series oldest→newest
    // ({ time, open, high, low, close }) for the SL/TP/trail walk.
    const series = candles
      .map(c => ({
        time: new Date(c.start).getTime(),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close)
      }))
      .filter(c => Number.isFinite(c.close) && Number.isFinite(c.high) && Number.isFinite(c.low))
      .sort((a, b) => a.time - b.time);

    return { high, low, firstClose, lastClose, series };
  } catch (e) {
    console.error(`[SHADOW] Candle fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

/**
 * AG1: Loads strategy_config parameters for (tenant, strategy) — point-in-time
 * config used to drive the strategy-true sim. Canonical param names are
 * tp_percent / sl_percent (take_profit_pct / stop_loss_pct are UI labels only).
 */
async function fetchStrategySimParams(tenantId, strategy) {
  try {
    const { data: cfg } = await supabase
      .from('strategy_config')
      .select('parameters')
      .eq('tenant_id', tenantId)
      .ilike('strategy', strategy)
      .maybeSingle();
    const p = cfg?.parameters || {};
    const num = (v) => (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) ? null : parseFloat(v);
    return {
      tp: num(p.tp_percent) ?? num(p.take_profit_pct) ?? num(p.take_profit_percentage) ?? num(p.target_profit_percentage),
      sl: num(p.sl_percent) ?? num(p.stop_loss_pct) ?? num(p.stop_loss_percentage),
      tripwire: num(p.tripwire_percent),
      trailStep: num(p.trail_step_percent),
      trailActivation: num(p.trail_activation_percent) ?? num(p.tripwire_percent),
      leverage: num(p.leverage) ?? 1,
      // qty is NOT a strategy_config param (lives on trade_logs). Convention:
      // parameters.qty if the tenant set it, else $1,000 notional default —
      // makes sim_pnl_usd a "config-$ per $1k" metric, signed, comparable.
      qty: num(p.qty) ?? null,
      qtySource: num(p.qty) != null ? 'config_qty' : 'default_1k'
    };
  } catch (e) {
    return { tp: null, sl: null, tripwire: null, trailStep: null, trailActivation: null, leverage: 1, qty: null, qtySource: 'default_1k' };
  }
}

/**
 * AG1: ATR-14 from the sim candle series (Wilder's smoothing on true range).
 * Fallback SL/TP geometry when strategy_config fields are missing.
 */
function computeATR14(series) {
  if (!series || series.length < 2) return null;
  const trs = [];
  for (let i = 1; i < series.length; i++) {
    const prevClose = series[i - 1].close;
    const tr = Math.max(
      series[i].high - series[i].low,
      Math.abs(series[i].high - prevClose),
      Math.abs(series[i].low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  let atr = trs.slice(0, Math.min(14, trs.length)).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
  for (let i = 14; i < trs.length; i++) {
    atr = ((atr * 13) + trs[i]) / 14;
  }
  return atr;
}

/**
 * AG1: Strategy-true shadow simulation — walks the 5m candle series mirroring
 * workers/watchdog.js ROE/tripwire/step-trail math EXACTLY (watchdog L393-560).
 * Watchdog parity notes:
 *   - ROE = rawPriceMove × leverage (rawPriceMove = side-adjusted price fraction).
 *   - SL wins intrabar ties (pessimistic: check SL before TP within a candle).
 *   - Tripwire: when ROE ≥ tripwire_percent, SL moves to break-even (entry ×1.001/0.999).
 *   - Step-trail: fires when ROE ≥ trailActivation (default = tripwire);
 *     per-step SL = currentPrice × (1 ∓ trailStep / leverage) — the /leverage
 *     conversion is watchdog's ROE→price-step mapping and MUST be replicated.
 *     Only ratchets (never loosens). No exchange-band clamp here (candles are
 *     already exchange data; clamp exists in watchdog for live WS noise).
 * Fallback SL/TP = macro-ATR geometry (1.5× / 2.0× ATR) when config missing —
 * the source actually used is recorded in sim_params.
 *
 * Returns null when the sim cannot resolve yet (horizon not reached / no data).
 */
function runShadowSim({ direction, entryPrice, series, simParams, atr, nowMs }) {
  if (!series || series.length === 0 || !entryPrice || !Number.isFinite(entryPrice)) return null;

  const leverage = simParams.leverage || 1;
  const isBuy = direction === 'BUY';
  const side = isBuy ? 'BUY' : 'SELL';

  // --- Resolve SL/TP price levels + record their source ---
  let slSource = null, tpSource = null;
  let slDist = null, tpDist = null; // price distance from entry (absolute)

  if (simParams.sl) {
    // sl_percent is an ROE fraction → price distance = ROE × entry / leverage
    slDist = (simParams.sl * entryPrice) / leverage;
    slSource = 'config_sl_percent';
  } else if (atr) {
    slDist = 1.5 * atr;
    slSource = 'atr_1.5x';
  }
  if (simParams.tp) {
    tpDist = (simParams.tp * entryPrice) / leverage;
    tpSource = 'config_tp_percent';
  } else if (atr) {
    tpDist = 2.0 * atr;
    tpSource = 'atr_2.0x';
  }
  if (!slDist && !tpDist) {
    // Nothing to exit on — degrade to horizon-only sim.
    slSource = 'none';
    tpSource = 'none';
  }

  let stopPrice = slDist != null ? (isBuy ? entryPrice - slDist : entryPrice + slDist) : null;
  let takePrice = tpDist != null ? (isBuy ? entryPrice + tpDist : entryPrice - tpDist) : null;

  const tripwire = simParams.tripwire || 0;
  const trailStep = simParams.trailStep || 0;
  const trailActivation = simParams.trailActivation ?? simParams.tripwire ?? 0;
  let tripped = false, trailing = false;
  let bars = 0, exitPrice = null, exitReason = null, exitTime = null;

  const HORIZON_MS = 24 * 3600 * 1000;

  for (const c of series) {
    bars++;
    exitTime = new Date(c.time).toISOString();

    const rawMove = isBuy ? (c.close - entryPrice) / entryPrice : (entryPrice - c.close) / entryPrice;
    const roe = rawMove * leverage;

    // Tripwire (watchdog L404-415): ROE ≥ tripwire_percent → SL to break-even
    if (!tripped && tripwire > 0 && roe >= tripwire) {
      tripped = true;
      stopPrice = isBuy ? entryPrice * 1.001 : entryPrice * 0.999;
    }
    // Step-trail (watchdog L543+): activation → ratchet SL by trailStep/leverage steps
    if (trailStep > 0 && roe >= trailActivation) {
      trailing = true;
      const stepDist = (trailStep / leverage) * c.close; // watchdog: currentPrice × (1 ∓ trailStep/leverage)
      const candidateStop = isBuy ? c.close - stepDist : c.close + stepDist;
      // ratchet only — never loosen
      if (stopPrice == null) stopPrice = candidateStop;
      else if (isBuy) stopPrice = Math.max(stopPrice, candidateStop);
      else stopPrice = Math.min(stopPrice, candidateStop);
    }

    // Pessimistic intrabar order: SL first (SL wins ties), then TP
    const hitSL = stopPrice != null && (isBuy ? c.low <= stopPrice : c.high >= stopPrice);
    const hitTP = takePrice != null && (isBuy ? c.high >= takePrice : c.low <= takePrice);

    if (hitSL) {
      exitPrice = stopPrice;
      exitReason = tripped || trailing ? 'TRAIL' : 'SL';
      break;
    }
    if (hitTP) {
      exitPrice = takePrice;
      exitReason = 'TP';
      break;
    }

    // 24h horizon: resolve on the last candle at/before the horizon
    if (c.time >= simParams.startMs + HORIZON_MS - 5 * 60 * 1000) {
      exitPrice = c.close;
      exitReason = 'HORIZON';
      break;
    }
  }

  // Unresolved: horizon not reached yet — skip this row until a later tick.
  if (!exitPrice) {
    const lastCandle = series[series.length - 1];
    if (simParams.startMs + HORIZON_MS > nowMs) return null; // still inside 24h window
    exitPrice = lastCandle.close;
    exitReason = 'HORIZON';
    exitTime = new Date(lastCandle.time).toISOString();
  }

  if (exitReason === 'TRIPWIRE') exitReason = 'TRIPWIRE'; // explicit (BE-stop via tripwire path tagged TRAIL above)

  // Signed move from entry, per unit. Tripwire BE-stop via the SL path is TRAIL;
  // pure config/ATR stop is SL. (Tripwire itself never exits — it re-positions SL.)
  const signedPts = isBuy
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;

  const simParamsRecord = {
    direction: side,
    leverage,
    sl: simParams.sl, tp: simParams.tp,
    tripwire_percent: simParams.tripwire,
    trail_step_percent: simParams.trailStep,
    trail_activation_percent: simParams.trailActivation,
    sl_source: slSource,
    tp_source: tpSource,
    atr_14: atr != null ? parseFloat(atr.toFixed(6)) : null,
    qty_source: simParams.qtySource
  };

  return {
    exitPrice,
    exitReason,
    exitTime,
    bars,
    signedPts,
    simParams: simParamsRecord
  };
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
  // Amounts (saved/missed) are computed by the CALLER in price points per 1 unit —
  // unified with the counterfactual path below. This function decides the verdict only.
  function determineVerdict(signalDirection, trade, vetoPrice) {
    const tradeIsBuy = (trade.side === 'BUY' || trade.side === 'LONG');
    const tradePnl = parseFloat(trade.pnl || 0);
    const tradeMadeMoney = tradePnl > 0;

    if (signalDirection === 'BUY') {
      if (tradeIsBuy) {
        // VETO was against a BUY signal, trader bought anyway
        if (tradeMadeMoney) return { verdict: 'MISSED' };
        else return { verdict: 'SAVED' };
      } else {
        // VETO was against BUY, trader shorted instead (contrarian)
        if (tradeMadeMoney) return { verdict: 'SAVED' };
        else return { verdict: 'MISSED' };
      }
    } else {
      // signalDirection is SELL
      if (!tradeIsBuy) {
        if (tradeMadeMoney) return { verdict: 'MISSED' };
        else return { verdict: 'SAVED' };
      } else {
        if (tradeMadeMoney) return { verdict: 'SAVED' };
        else return { verdict: 'MISSED' };
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
      // � EVALUATION AGE GATE (AG1): 24h sim horizon must fully elapse before
      // labeling — unresolved rows are skipped and retried on later ticks.
      .lt('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
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
      // 🟢 shadow-v2: price basis used for Path B amounts ('far_side' | 'mid_legacy'); null for Path A
      let fillBasis = null;
      // AG1: strategy-true sim outputs (Path B only)
      let simExitPrice = null, simExitTime = null, simExitReason = null;
      let simPnlPts = null, simPnlUsd = null, simBars = null, simParamsJson = null;

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

        // Fee: tenant taker rate × 2 (round trip), in price points.
        // hermes-brain.js pattern — 0.0008 fallback, never 0.
        let feeRate = 0.0008;
        try {
          const { data: agentSettings } = await supabase
            .from('tenant_settings')
            .select('agent_taker_fee_rate')
            .eq('tenant_id', scan.tenant_id)
            .single();
          if (agentSettings?.agent_taker_fee_rate) feeRate = parseFloat(agentSettings.agent_taker_fee_rate) || 0.0008;
        } catch (e) {}
        const feePoints = feeRate * priceForCalc * 2;

        const result = determineVerdict(signalDirection, matchingTrade, priceForCalc);
        verdict = result.verdict;
        // amounts = price points per 1 unit (NOT dollars) — unified with counterfactual path
        const tradeExit = parseFloat(matchingTrade.exit_price) || priceForCalc;
        if (verdict === 'SAVED') savedAmount = Math.abs(tradeExit - priceForCalc) + feePoints;
        else if (verdict === 'MISSED') missedAmount = Math.abs(tradeExit - priceForCalc) + feePoints;
      } else {
        // No trade followed — AG1 strategy-true shadow simulation (Path B replacement).
        // 24h horizon via sim engine; row is SKIPPED (not inserted) until the sim
        // resolves (exit hit) or the horizon is reached — fetch what exists each tick.
        const startMs = new Date(vetoTime).getTime();
        const candleData = await fetchCounterfactualCandles(asset, vetoTime, 24, scan.tenant_id);
        if (candleData && candleData.series && vetoPrice) {
          cLow = candleData.low;
          cHigh = candleData.high;

          // 🟢 shadow-v2: far-side entry bound (QuanTradin's rule — pessimistic or nothing).
          // BUY veto → we'd have paid best_ask; SELL veto → we'd have sold at best_bid.
          let farEntry = vetoPrice;
          fillBasis = 'mid_legacy';
          let lt = signal?.telemetry || {};
          if (typeof lt === 'string') { try { lt = JSON.parse(lt); } catch (e) { lt = {}; } }
          const bestAsk = parseFloat(lt.best_ask) || null;
          const bestBid = parseFloat(lt.best_bid) || null;
          if (signalDirection === 'BUY' && bestAsk) { farEntry = bestAsk; fillBasis = 'far_side'; }
          if (signalDirection === 'SELL' && bestBid) { farEntry = bestBid; fillBasis = 'far_side'; }

          const simParams = await fetchStrategySimParams(scan.tenant_id, scan.strategy);
          const atr = computeATR14(candleData.series);
          const sim = runShadowSim({
            direction: signalDirection,
            entryPrice: farEntry,
            series: candleData.series,
            simParams: { ...simParams, startMs },
            atr,
            nowMs: Date.now()
          });

          if (!sim) {
            // Unresolved — skip until a later 5-min tick (24h horizon not reached).
            continue;
          }

          // Fee: tenant taker rate × 2 (round trip), in price points, on entry.
          let feeRate = 0.0008;
          try {
            const { data: agentSettings } = await supabase
              .from('tenant_settings')
              .select('agent_taker_fee_rate')
              .eq('tenant_id', scan.tenant_id)
              .single();
            if (agentSettings?.agent_taker_fee_rate) feeRate = parseFloat(agentSettings.agent_taker_fee_rate) || 0.0008;
          } catch (e) {}
          const feePoints = feeRate * farEntry * 2;

          simExitPrice = sim.exitPrice;
          simExitTime = sim.exitTime;
          simExitReason = sim.exitReason;
          simBars = sim.bars;
          simPnlPts = sim.signedPts - feePoints; // per-unit, minus round-trip fees
          simParamsJson = sim.simParams;

          const qty = simParams.qty != null ? simParams.qty : 1000; // $1k notional default
          simPnlUsd = simPnlPts * qty;

          // saved/missed = |sim_pnl_pts| + fees into the SAME legacy columns.
          const magnitude = Math.abs(sim.signedPts) + feePoints;
          if (sim.signedPts > 0) { verdict = 'MISSED'; missedAmount = magnitude; }
          else if (sim.signedPts < 0) { verdict = 'SAVED'; savedAmount = magnitude; }
          else { verdict = 'NEUTRAL'; }
        }
      }

      // 🟢 PUSH AA: stamp the strategy's TF pair at veto time (point-in-time)
      let macroTf = 'ANY', triggerTf = 'ANY';
      try {
        const { data: cfg } = await supabase.from('strategy_config')
          .select('parameters')
          .eq('tenant_id', scan.tenant_id)
          .ilike('strategy', scan.strategy)
          .maybeSingle();
        const p = cfg?.parameters || {};
        macroTf = p.macro_tf || 'ANY';
        triggerTf = p.trigger_tf || 'ANY';
      } catch (e) { /* fallback ANY/ANY */ }

      // 🟢 AK2: admission control — two-ledger truth. A row is ADMITTED only if no
      // OTHER shadow row for the same (tenant, asset) overlaps its
      // [veto_time, sim_exit_time] window. Unresolved priors count as overlapping
      // (their provisional exit is now). Config-$ series uses admitted rows only;
      // ledger + % stats + decision counts keep ALL rows.
      let admitted = true;
      try {
        const windowEnd = simExitTime || new Date().toISOString();
        const { data: overlapping } = await supabase
          .from('shadow_portfolio')
          .select('id, veto_time, sim_exit_time')
          .eq('tenant_id', scan.tenant_id)
          .eq('asset', asset)
          .lt('veto_time', windowEnd)
          .gte('veto_time', new Date(new Date(vetoTime).getTime() - 24 * 3600 * 1000).toISOString());
        const overlaps = (overlapping || []).some(o => {
          const oEnd = o.sim_exit_time || new Date().toISOString(); // unresolved → provisional now
          return new Date(o.veto_time) < new Date(windowEnd) && new Date(oEnd) > new Date(vetoTime);
        });
        admitted = !overlaps;
      } catch (e) {
        console.error(`[SHADOW] Admission check failed for scan ${scan.id}:`, e.message);
        admitted = true; // fail-open: keep the row in the ledger
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
          counterfactual_direction: cDirection,
          // 🟢 shadow-v2: which price basis produced the amounts (far_side | mid_legacy | null=Path A)
          fill_basis: fillBasis,
          // 🟢 PUSH AA: point-in-time TF pair
          macro_tf: macroTf,
          trigger_tf: triggerTf,
          // AG1: strategy-true sim outputs (Path B only; null for Path A + legacy rows)
          sim_exit_price: simExitPrice !== null ? parseFloat(simExitPrice.toFixed(2)) : null,
          sim_exit_time: simExitTime,
          sim_exit_reason: simExitReason,
          sim_bars: simBars,
          sim_pnl_pts: simPnlPts !== null ? parseFloat(simPnlPts.toFixed(6)) : null,
          sim_pnl_usd: simPnlUsd !== null ? parseFloat(simPnlUsd.toFixed(2)) : null,
          sim_params: simParamsJson,
          // AK2: admission flag (no overlapping same-asset shadow position at label time)
          admitted,
          autopsied_at: null
        }]);

      if (insertError) {
        console.error(`[SHADOW] Insert failed for scan ${scan.id}:`, insertError.message);
      } else {
        const amount = savedAmount > 0 ? `SAVED ${savedAmount.toFixed(2)} pts` : missedAmount > 0 ? `MISSED ${missedAmount.toFixed(2)} pts` : 'NEUTRAL';
        console.log(`[SHADOW] ✅ ${asset} VETO ${scan.id} @ ${vetoTime}: ${signalDirection} → ${verdict} (${amount})`);
        // AG2: Discord resolution notification (SAVED/MISSED only; NEUTRAL skipped).
        await notifyShadowResolution({
          tenant_id: scan.tenant_id,
          verdict,
          asset,
          signal_direction: signalDirection,
          veto_price: vetoPrice,
          veto_regime: vetoRegime,
          sim_exit_price: simExitPrice,
          sim_exit_reason: simExitReason,
          sim_pnl_pts: simPnlPts,
          sim_bars: simBars,
          sim_params: simParamsJson,
          saved_amount: savedAmount,
          missed_amount: missedAmount,
          actual_move_pct: actualMovePct
        });
      }
    }
  } catch (e) {
    console.error('[SHADOW] Fatal:', e.message);
  } finally {
    active = false;
  }
}

/**
 * AG3: 6h shadow autopsy feed — batches shadow rows labeled in the window with
 * autopsied_at IS NULL, POSTs them to /api/autopsy with scope:'shadow', and
 * stamps autopsied_at on success. DEAD CODE until hermes-brain.js (Render) is
 * redeployed with the scope:'shadow' branch — POSTs will 404 silently and rows
 * remain un-autopsied (safe retry semantics).
 */
let autopsyActive = false;

function getAutopsyUrl() {
  return process.env.HERMES_BRAIN_URL
    ? `${process.env.HERMES_BRAIN_URL.replace(/\/$/, '')}/api/autopsy`
    : 'http://localhost:8000/api/autopsy';
}

async function processShadowAutopsies() {
  if (autopsyActive) return;
  autopsyActive = true;

  try {
    // Rows labeled in the last 7 days, not yet autopsied.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from('shadow_portfolio')
      .select('id, tenant_id, scan_id, asset, signal_direction, verdict, veto_regime, macro_tf, trigger_tf, sim_exit_price, sim_exit_reason, sim_pnl_pts, sim_pnl_usd, sim_params, veto_price, veto_time')
      .is('autopsied_at', null)
      .gte('veto_time', cutoff)
      .order('id', { ascending: true })
      .limit(50);

    if (error) { console.error('[SHADOW-AUTOPSY] Query failed:', error.message); return; }
    if (!rows || rows.length === 0) return;

    console.log(`[SHADOW-AUTOPSY] Feeding ${rows.length} shadow row(s) to /api/autopsy...`);

    for (const row of rows) {
      // Cited memories live in the paired scan's telemetry (sniper.js PUSH).
      let citedMemories = null;
      try {
        const { data: scan } = await supabase
          .from('scan_results')
          .select('telemetry')
          .eq('id', row.scan_id)
          .maybeSingle();
        let t = scan?.telemetry || {};
        if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = {}; } }
        citedMemories = t.cited_memories || null;
      } catch (e) {}

      try {
        const resp = await fetch(getAutopsyUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'shadow',
            shadow_id: row.id,
            // trade_log_id: null ALWAYS — shadow autopsies must never collide with
            // the real trade's autopsy dedup (044 uniq index / AUTOPSKIP).
            trade_log_id: null,
            tenant_id: row.tenant_id,
            asset: row.asset,
            signal_direction: row.signal_direction,
            entry_price: row.veto_price,
            exit_price: row.sim_exit_price,
            pnl: row.sim_pnl_pts,
            verdict: row.verdict,
            regime_at_close: row.veto_regime,
            macro_tf: row.macro_tf,
            trigger_tf: row.trigger_tf,
            sim_exit_reason: row.sim_exit_reason,
            sim_pnl_usd: row.sim_pnl_usd,
            sim_params: row.sim_params,
            cited_memories: citedMemories,
            market_snapshot: null,
            rolling_ledger: null
          })
        });
        if (!resp.ok) {
          console.error(`[SHADOW-AUTOPSY] POST failed for shadow ${row.id}: HTTP ${resp.status}`);
          continue; // retry on next 6h tick
        }
        const { error: upErr } = await supabase
          .from('shadow_portfolio')
          .update({ autopsied_at: new Date().toISOString() })
          .eq('id', row.id);
        if (upErr) console.error(`[SHADOW-AUTOPSY] Stamp failed for shadow ${row.id}:`, upErr.message);
        else console.log(`[SHADOW-AUTOPSY] ✅ shadow ${row.id} (${row.asset} ${row.verdict}) autopsied.`);
      } catch (e) {
        console.error(`[SHADOW-AUTOPSY] POST error for shadow ${row.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[SHADOW-AUTOPSY] Fatal:', e.message);
  } finally {
    autopsyActive = false;
  }
}

export function startShadowPortfolio() {
  console.log('[SHADOW] v2 Shadow Portfolio worker starting (corrected signal direction)...');

  processUnlabeledVetos();

  setInterval(() => {
    processUnlabeledVetos();
  }, 5 * 60 * 1000);

  // AG3: 6h shadow autopsy feed (dead until brain service redeploy — safe to run now).
  processShadowAutopsies();
  setInterval(() => {
    processShadowAutopsies();
  }, 6 * 3600 * 1000);

  console.log('[SHADOW] v2 worker active (5 min interval, 6h autopsy feed).');
}