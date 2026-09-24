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
// 🟢 AM2f — small candle cache keyed `${spotSymbol}:${Math.floor(startMs/600)}`
// (10-min buckets) with a 10-min TTL — cuts CDP rate-limit pressure when the
// sweep re-fetches the same veto window tick after tick.
const candleCache = new Map();
const CANDLE_CACHE_TTL_MS = 10 * 60 * 1000;
// 🟢 AM15 — empty/negative results are cached for 30s only, so a poisoned cache
// can never keep serving candles=0 across ticks.
const CANDLE_NEGATIVE_TTL_MS = 30 * 1000;
// 🟢 AM24 — 429 backoff: exponential delays between retries (1s → 4s → 8s),
// max 2 retries per attempt path. CDP rate limits are per API key, so the
// multi-asset sweep hammering requests back-to-back is a textbook tail-asset
// rate-limit pattern.
const BACKOFF_DELAYS_MS = [1000, 4000, 8000];
const SWEEP_STAGGER_MS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 🟢 AM24 — fetch with exponential backoff on HTTP 429 only. Non-429 failures
 * return immediately (per-asset isolation: retries never starve other assets).
 * Honors Retry-After when it exceeds the computed delay. Returns the Response
 * of the last attempt (caller handles !resp.ok).
 */
async function fetchWithBackoff(url, options, logTag) {
  let resp = await fetch(url, options);
  for (const delayMs of BACKOFF_DELAYS_MS) {
    if (resp.status !== 429) return resp;
    // Honor Retry-After if present and larger than our computed delay.
    let waitMs = delayMs;
    const ra = parseInt(resp.headers?.get?.('retry-after'), 10);
    if (Number.isFinite(ra) && ra * 1000 > waitMs) waitMs = ra * 1000;
    console.warn(`[SHADOW] Candle fetch ${logTag}: 429 — backing off ${waitMs}ms before retry`);
    await sleep(waitMs);
    resp = await fetch(url, options);
  }
  return resp;
}

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
    // 🟢 AM2f — CDP v3 candles expects ISO 8601 start/end (epoch seconds → 400,
    // which the old silent `if (!resp.ok) return null` swallowed — sims never
    // graded). Send ISO, keep granularity=FIVE_MINUTE.
    // 🟢 AM2g — dual-format: try ISO first; on !resp.ok retry with epoch seconds
    // (settle ISO-vs-epoch-vs-auth in one tick). Both outcomes logged loudly.
    const startMs = new Date(startTime).getTime();
    // 🟢 AM15 — window clamp: a fetch window reaching into the future must never
    // be passed to the exchange API (Coinbase empties/rejects it, which silently
    // froze every ticket). Clamp end to now; if <5min of window exists there is
    // nothing to walk yet — return null gracefully (not an error).
    let endMs = Math.min(startMs + hours * 3600 * 1000, Date.now());
    if (endMs - startMs < 5 * 60 * 1000) {
      console.log(`[SHADOW] Candle fetch ${spotSymbol}: window not started yet — skipping (start=${Math.floor(startMs / 1000)} end=${Math.floor(endMs / 1000)})`);
      return null;
    }
    const iso = (ms) => new Date(ms).toISOString();

    // 🟢 AM2f — cache hit: same symbol + same 10-min bucket → reuse the series.
    // 🟢 AM15 — negative entries (empty series) expire after 30s, not 10min.
    const cacheKey = `${spotSymbol}:${Math.floor(startMs / 600)}`;
    const cached = candleCache.get(cacheKey);
    const ttl = (cached && cached.negative) ? CANDLE_NEGATIVE_TTL_MS : CANDLE_CACHE_TTL_MS;
    if (cached && (Date.now() - cached.fetchedAt) < ttl) {
      return cached.data;
    }

    const mkPath = (s, e) => `/api/v3/brokerage/products/${spotSymbol}/candles?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}&granularity=FIVE_MINUTE`;
    const isoPath = mkPath(iso(startMs), iso(endMs));
    const epochPath = mkPath(Math.floor(startMs / 1000), Math.floor(endMs / 1000));

    // 🟢 AM24 — failure logs ALWAYS carry the exact params (spot, start epoch,
    // end epoch, granularity) so any failure is diagnosable from logs alone.
    const paramsSuffix = () => `start=${Math.floor(startMs / 1000)} end=${Math.floor(endMs / 1000)} granularity=FIVE_MINUTE`;

    // 🟢 AM24 — 429 backoff applied per format attempt (ISO ladder first, then
    // epoch ladder on format fallback). Non-429 failures fall through instantly.
    let resp = await fetchWithBackoff(`https://api.coinbase.com${isoPath}`, {
      headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', isoPath, apiKey, apiSecret)}` }
    }, spotSymbol);
    const isoStatus = resp.status;
    if (!resp.ok) {
      const isoBody = await resp.text().catch(() => '');
      console.error(`[SHADOW] Candle fetch ${spotSymbol}: ISO FAILED ${isoStatus} ${isoBody.slice(0, 200)} — ${paramsSuffix()}`);
      const epochPathStr = epochPath;
      resp = await fetchWithBackoff(`https://api.coinbase.com${epochPathStr}`, {
        headers: { 'Authorization': `Bearer ${generateCoinbaseToken('GET', epochPathStr, apiKey, apiSecret)}` }
      }, spotSymbol);
      console.error(`[SHADOW] Candle fetch ${spotSymbol}: ISO→${isoStatus}, epoch→${resp.status}`);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[SHADOW] Candle fetch ${spotSymbol} FAILED: ${resp.status} ${body.slice(0, 200)} — ${paramsSuffix()}`);
        return null;
      }
      console.log(`[SHADOW] Candle fetch ${spotSymbol}: OK via epoch (ISO→${isoStatus})`);
    }
    const data = await resp.json();
    const candles = data?.candles;
    if (!candles || !Array.isArray(candles) || candles.length === 0) {
      // 🟢 AM15 — LOUD empty diagnostics: this is the case that silently froze
      // every ticket; start/end/granularity in one line pins params-vs-product.
      console.error(`[SHADOW] Candle fetch ${spotSymbol}: 200 but EMPTY — start=${Math.floor(startMs / 1000)} end=${Math.floor(endMs / 1000)} granularity=FIVE_MINUTE`);
      // 🟢 AM15 — 30s negative cache: empties are NEVER cached at the 10-min TTL.
      candleCache.set(cacheKey, { data: null, fetchedAt: Date.now(), negative: true });
      return null;
    }

    let high = -Infinity, low = Infinity;
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    high = Math.max(...highs);
    low = Math.min(...lows);
    const firstClose = parseFloat(candles[candles.length - 1].close); // OLDEST candle
    const lastClose = parseFloat(candles[0].close); // NEWEST candle

    // AG1 sim engine: normalized chronological series oldest→newest
    // ({ time, open, high, low, close }) for the SL/TP/trail walk.
    // 🟢 AM25 — CDP epoch-path responses return `start` as an epoch-SECONDS
    // string; new Date(<numeric string>) parses it as a year → Invalid Date →
    // NaN → the validity filter dropped every candle → 'EMPTY after validity
    // filter' forever. Numeric epoch-seconds values multiply by 1000; ISO
    // strings keep the Date parse. Both formats now map correctly.
    const series = candles
      .map(c => ({
        time: (typeof c.start === 'number' || /^\d+$/.test(String(c.start)))
              ? Number(c.start) * 1000
              : new Date(c.start).getTime(),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close)
      }))
      // 🟢 AM2e — time validity on the MAPPED object (c.time is epoch ms from
      // c.start; raw Coinbase candles carry no c.time field). Poisoned/garbage
      // timestamps would skew sim_exit_time and every downstream window.
      .filter(c => Number.isFinite(c.time) && Number.isFinite(c.close) && Number.isFinite(c.high) && Number.isFinite(c.low))
      .sort((a, b) => a.time - b.time);

    // 🟢 AM25 — one-line shape diagnostics: series length + first/last time so
    // any future response-shape change is visible immediately.
    console.log(`[SHADOW] Candle map ${spotSymbol}: n=${series.length} first=${series[0]?.time} last=${series[series.length - 1]?.time}`);

    // 🟢 AM15 — never cache empties: a non-empty raw candles array whose entries
    // all fail the validity filter yields series=[] — caching THAT result was
    // the real poisoning path (200-but-empty served as candles=0 for 10min).
    if (series.length === 0) {
      console.error(`[SHADOW] Candle fetch ${spotSymbol}: 200 but EMPTY after validity filter — start=${Math.floor(startMs / 1000)} end=${Math.floor(endMs / 1000)} granularity=FIVE_MINUTE`);
      candleCache.set(cacheKey, { data: null, fetchedAt: Date.now(), negative: true });
      return null;
    }

    const result = { high, low, firstClose, lastClose, series };
    // 🟢 AM2f/AM15 — cache only successful non-empty fetches; prune stale entries opportunistically.
    candleCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    if (candleCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of candleCache) {
        if ((now - v.fetchedAt) >= CANDLE_CACHE_TTL_MS) candleCache.delete(k);
      }
    }
    return result;
  } catch (e) {
    console.error(`[SHADOW] Candle fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

/**
 * AG1: Loads strategy_config parameters for (tenant, strategy, ASSET) — point-in-time
 * config used to drive the strategy-true sim. 🟢 AM2d: strategy_config is per-asset
 * and multi-row (is_active toggles) — lookups MUST filter asset + is_active or
 * PostgREST errors on N rows and every sim degrades to horizon-only.
 * Canonical param names are tp_percent / sl_percent (take_profit_pct /
 * stop_loss_pct are UI labels only).
 */
async function fetchStrategySimParams(tenantId, strategy, asset) {
  try {
    const { data: cfg } = await supabase
      .from('strategy_config')
      .select('id, parameters')
      .eq('tenant_id', tenantId)
      .ilike('strategy', strategy)
      .eq('asset', asset)
      .eq('is_active', true)
      .limit(1);
    const row = (Array.isArray(cfg) && cfg[0]) || null;
    const p = row?.parameters || {};
    const num = (v) => (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) ? null : parseFloat(v);
    return {
      // 🟢 AM7 — config-as-truth: the governing strategy_config row id, stamped
      // into params_context at resolution so the trainer can join on it.
      configId: row?.id ?? null,
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
    return { configId: null, tp: null, sl: null, tripwire: null, trailStep: null, trailActivation: null, leverage: 1, qty: null, qtySource: 'default_1k' };
  }
}

// 🟢 PUSH AM21 — resolve COMPLETE ticket levels (entry + SL/TP absolutes).
// Priority: agent decision absolutes (AM4) > active-config fractions (AM6a
// price-fraction math: dist = fraction × entry, absolutes = entry ∓ dist by
// direction). Returns entry=null when no price could be resolved anywhere —
// the caller must then REJECT the ticket, never insert a zombie.
function resolveTicketLevels({ entry, direction, configFracs, agentTpPrice, agentSlPrice }) {
  const entryNum = entry != null ? parseFloat(entry) : null;
  if (entryNum == null || !Number.isFinite(entryNum) || entryNum <= 0) {
    return { entry: null, sl_price: null, tp_price: null, sl_src: null, tp_src: null };
  }
  const isBuy = direction !== 'SELL';
  const fin = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
  let slPrice = fin(agentSlPrice), slSrc = slPrice != null ? 'agent' : null;
  if (slPrice == null && configFracs?.sl != null) {
    const dist = configFracs.sl * entryNum;
    slPrice = isBuy ? entryNum - dist : entryNum + dist;
    slSrc = 'config';
  }
  let tpPrice = fin(agentTpPrice), tpSrc = tpPrice != null ? 'agent' : null;
  if (tpPrice == null && configFracs?.tp != null) {
    const dist = configFracs.tp * entryNum;
    tpPrice = isBuy ? entryNum + dist : entryNum - dist;
    tpSrc = 'config';
  }
  return { entry: entryNum, sl_price: slPrice, tp_price: tpPrice, sl_src: slSrc, tp_src: tpSrc };
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
    // 🟢 AM6a: sl_percent is a PRICE fraction by config convention → price
    // distance = fraction × entry (no /leverage). Leverage belongs only in the
    // watchdog-mirrored tripwire/trail ROE logic below.
    slDist = simParams.sl * entryPrice;
    slSource = 'config_sl_percent';
  } else if (atr) {
    slDist = 1.5 * atr;
    slSource = 'atr_1.5x';
  }
  if (simParams.tp) {
    tpDist = simParams.tp * entryPrice;
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
    // 🟢 AM2e — exit time MUST be deterministic from the sim's own 5m timeline
    // (veto start + bar index), never trusted from candle.time (exchange gaps/
    // skew poison the sim_exit_time and downstream windows). bars is 1-based,
    // so (bars - 1) is the 0-based candle index on the 5m grid.
    exitTime = new Date(simParams.startMs + (bars - 1) * 5 * 60 * 1000).toISOString();

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
    // 🟢 AM2e — same deterministic timeline rule as the in-loop exit: the last
    // candle walked is index (bars - 1) on the 5m grid from veto start.
    exitTime = new Date(simParams.startMs + (bars - 1) * 5 * 60 * 1000).toISOString();
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
    // 🟢 PUSH AM4 — provenance: agent_adjusted beats config labels when the
    // worker overrode the params from the veto telemetry.
    sl_source: simParams.paramSource === 'agent_adjusted' ? 'agent_adjusted' : slSource,
    tp_source: simParams.paramSource === 'agent_adjusted' ? 'agent_adjusted' : tpSource,
    param_source: simParams.paramSource || 'config_default',
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

// 🟢 PUSH AL — admission check shared by PENDING inserts and resolution updates.
// Same overlap block as the AK2 block below, but the candidate's window end is
// passed in explicitly (provisional veto_time+24h for PENDING; real sim_exit_time
// at resolution). Excludes the candidate's own row by id when updating.
async function computeAdmitted({ tenantId, asset, vetoTime, windowEnd, excludeId = null }) {
  try {
    let q = supabase
      .from('shadow_portfolio')
      .select('id, veto_time, sim_exit_time')
      .eq('tenant_id', tenantId)
      .eq('asset', asset)
      .lt('veto_time', windowEnd)
      .gte('veto_time', new Date(new Date(vetoTime).getTime() - 24 * 3600 * 1000).toISOString());
    if (excludeId) q = q.neq('id', excludeId);
    const { data: overlapping } = await q;
    const overlaps = (overlapping || []).some(o => {
      const oEnd = o.sim_exit_time || new Date().toISOString(); // unresolved → provisional now
      return new Date(o.veto_time) < new Date(windowEnd) && new Date(oEnd) > new Date(vetoTime);
    });
    return !overlaps;
  } catch (e) {
    console.error('[SHADOW] Admission check failed:', e.message);
    return true; // fail-open: keep the row in the ledger
  }
}

// 🟢 PUSH AL — insert the PENDING ticket the moment the worker first sees a veto
// (verdict PENDING, sim fields null, sim_params stamped) so the chart shows a LIVE
// ticket with TP/SL lines. Idempotent: skips when a row already exists for the scan.
// Never throws — log + continue; the sweep must not die on an insert failure.
async function insertPendingTicket({ scan, asset, signalDirection, vetoPrice, vetoRegime, simParams, macroTf, triggerTf, fillBasis, tpPrice, slPrice, paramsContext, configFracs, entrySrc }) {
  // 🟢 AM2 — veto_price can arrive as a STRING (signal.price from telemetry). Never
  // call .toFixed on it directly; parse once, guard NaN, and stamp a clean number.
  const priceNum = vetoPrice != null ? parseFloat(vetoPrice) : null;
  // 🟢 PUSH AM21 — INSERT GATE: a PENDING ticket may never be born incomplete.
  // No resolvable entry price anywhere → NO ticket. Returns BEFORE the open-cap
  // check so a zombie never owns the one-open-ticket-per-asset slot.
  if (priceNum == null || isNaN(priceNum) || priceNum <= 0) {
    console.log(`[SHADOW] TICKET REJECTED ${asset}: no entry price (scan ${scan.id})`);
    return null;
  }
  // 🟢 PUSH AM21 — complete-at-insert: agent absolutes override, config
  // fractions fill the gaps (AM6a price-fraction math).
  const resolved = resolveTicketLevels({
    entry: priceNum, direction: signalDirection, configFracs,
    agentTpPrice: tpPrice, agentSlPrice: slPrice
  });
  // 🟢 PUSH AM21 — PROVENANCE LOG: every stamp names its source.
  console.log(`[SHADOW] STAMP ${asset}: entry=${entrySrc || 'veto_price'} sl=${resolved.sl_src || 'none'} tp=${resolved.tp_src || 'none'} (scan ${scan.id})`);
  try {
    const { data: dup } = await supabase
      .from('shadow_portfolio')
      .select('id')
      .eq('scan_id', scan.id)
      .limit(1);
    if (dup && dup.length > 0) return null; // already exists (PENDING or resolved) — idempotent

    // 🟢 AM2 — open-cap: one open (PENDING) ticket per (tenant, asset). The AK2
    // `admitted` flag only gates config-$; this is the blocking layer.
    const { data: openSibling } = await supabase
      .from('shadow_portfolio')
      .select('id')
      .eq('tenant_id', scan.tenant_id)
      .eq('asset', asset)
      .eq('verdict', 'PENDING')
      .limit(1);
    if (openSibling && openSibling.length > 0) {
      console.log(`[SHADOW] SKIPPED_OPEN_EXISTS ${scan.id} ${asset} — one open ticket per asset.`);
      return false;
    }

    // Provisional admission: window end = veto_time + 24h (the sim's max horizon).
    const provisionalEnd = new Date(new Date(scan.created_at).getTime() + 24 * 3600 * 1000).toISOString();
    const admitted = await computeAdmitted({
      tenantId: scan.tenant_id,
      asset,
      vetoTime: scan.created_at,
      windowEnd: provisionalEnd
    });

    const { data: insData, error: pErr } = await supabase
      .from('shadow_portfolio')
      .insert([{
        tenant_id: scan.tenant_id,
        scan_id: scan.id,
        asset,
        signal_direction: signalDirection,
        conviction_score: null,
        veto_price: priceNum != null && !isNaN(priceNum) ? parseFloat(priceNum.toFixed(2)) : null,
        veto_time: scan.created_at,
        veto_regime: vetoRegime,
        trade_log_id: null,
        trade_side: null,
        trade_pnl: null,
        verdict: 'PENDING',
        saved_amount: 0,
        missed_amount: 0,
        actual_move_pct: null,
        duration_minutes: null,
        counterfactual_low: null,
        counterfactual_high: null,
        counterfactual_direction: null,
        fill_basis: fillBasis || null,
        macro_tf: macroTf,
        trigger_tf: triggerTf,
        sim_exit_price: null,
        sim_exit_time: null,
        sim_exit_reason: null,
        sim_bars: null,
        sim_pnl_pts: null,
        sim_pnl_usd: null,
        // 🟢 AM2e — percent mirrors for the chart: PENDING tickets draw TP/SL
        // price lines from tp_pct/sl_pct (percent vs veto_price) in
        // pages/index.js. runShadowSim keeps consuming the fraction tp/sl;
        // spread-copy so the shared simParams object is never mutated.
        sim_params: simParams
          ? {
              ...simParams,
              // 🟢 PUSH AM4 — provenance + absolute agent levels. pages/index.js
              // prefers tp_price/sl_price over tp_pct/sl_pct, so the chart draws
              // the agent's EXACT levels when the agent adjusted them.
              param_source: simParams.paramSource || 'config_default',
              // 🟢 PUSH AM21 — complete-at-insert absolutes (agent > config)
              // + provenance keys so a null field can never pass silently.
              tp_price: resolved.tp_price,
              sl_price: resolved.sl_price,
              entry_source: entrySrc || 'veto_price',
              sl_source: resolved.sl_src,
              tp_source: resolved.tp_src,
              tp_pct: simParams.tp != null ? simParams.tp * 100 : null,
              sl_pct: simParams.sl != null ? simParams.sl * 100 : null
            }
          : null,
        // 🟢 AM7 — params at close: config_id + agent diff, stamped at ticket
        // creation so PENDING rows carry provenance before resolution.
        params_context: paramsContext || null,
        admitted,
        autopsied_at: null
      }])
      .select('id');
    if (pErr) {
      console.error(`[SHADOW] PENDING insert failed for scan ${scan.id}:`, pErr.message);
      return null; // insert failed — caller must NOT treat this as a live ticket
    }
    console.log(`[SHADOW] PENDING ticket ${scan.id} ${asset} ${signalDirection || '—'}`);
    return insData && insData[0] ? insData[0] : null;
  } catch (e) {
    console.error(`[SHADOW] PENDING insert error for scan ${scan.id}:`, e.message);
    return null;
  }
}

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
      // 🟢 PUSH AL — maturity gate REMOVED. PENDING tickets must go LIVE on the
      // first 5-min tick after the veto (chart shows LIVE + TP/SL lines from
      // sim_params). runShadowSim returns null while unresolved, so young vetos
      // just stay PENDING until the sim resolves or the 24h horizon is reached.
      .order('created_at', { ascending: true });

    if (error) { console.error('[SHADOW] Query failed:', error.message); return; }
    if (!vetos || vetos.length === 0) { return; }

    // 2. Exclude already-labeled scans — 🟢 PUSH AL: a scan is excluded ONLY when
    // its shadow row exists AND verdict != 'PENDING'. PENDING rows stay in the
    // sweep so they can be UPDATED at resolution. Map scanId → pendingRow.
    const scanIds = vetos.map(v => v.id);
    const { data: existing } = await supabase
      .from('shadow_portfolio')
      .select('id, scan_id, verdict, veto_price, sim_params')
      .in('scan_id', scanIds);

    const pendingByScanId = new Map();
    const labeledIds = new Set();
    for (const e of (existing || [])) {
      if (e.verdict === 'PENDING') pendingByScanId.set(e.scan_id, e);
      else labeledIds.add(e.scan_id);
    }
    const unlabeled = vetos.filter(v => !labeledIds.has(v.id));

    if (unlabeled.length === 0) { return; }

    console.log(`[SHADOW] Processing ${unlabeled.length} unlabeled veto(s)...`);

    // 🟢 AM24 — tenant-aware stagger (Option B): CDP rate limits are per API
    // key, so only CONSECUTIVE fetches for the SAME tenant are spaced 2s apart.
    // Fossil-skipped scans never fetch, so they don't inflate tick duration.
    let lastFetchedTenantId = null;

    for (const scan of unlabeled) {
      const asset = scan.asset;
      const vetoTime = scan.created_at;

      // 🟢 AM26 — for-body scope: BOTH Path A (computeAdmitted excludeId) and
      // Path B (AM7b debug, AM21 heal, resolution merge) reference pendingRow.
      const pendingRow = pendingByScanId.get(scan.id) || null;

      // 🟢 AM2b — freshness gate for the WHOLE scan. Fossils (no ticket yet) are
      // never graded (Path A or B), never inserted, never pinged — they age out.
      // Existing PENDING rows bypass: they must keep resolving.
      // 🟢 AM2c — invalid dates must skip, not sail through (NaN age passes >).
      const vetoAgeMs = Date.now() - new Date(vetoTime).getTime();
      if (!Number.isFinite(vetoAgeMs) || (vetoAgeMs > 2 * 3600 * 1000 && !pendingByScanId.has(scan.id))) continue;

      // 🟢 AM2c — per-scan containment: one poisoned scan (invalid date throwing
      // RangeError deeper in the loop) must not kill the whole sweep every tick.
      // Mirrors the autopsy loop's per-row guard. Body indentation unchanged.
      try {
      const telemetry = scan.telemetry || {};
      const oracleReasoning = telemetry.oracle_reasoning || '';

      // 🥇 Fetch paired signal scan for direction, price, regime
      const signal = await fetchPairedSignal(scan.id, asset);

      let vetoPrice = signal?.price || null;
      let vetoRegime = signal?.regime || null;
      // 🟢 PUSH AM21 — entry provenance source for the STAMP log.
      let vetoPriceSrc = signal?.price ? 'signal' : null;
      const signalDirection = inferSignalDirection(signal?.marketState, oracleReasoning);
      const convictionScore = extractConvictionScore(telemetry, oracleReasoning);

      // Fallback: extract price from oracle_reasoning text if no signal scan found
      if (!vetoPrice) {
        const match = oracleReasoning.match(/\$(\d+\.?\d*)/);
        vetoPrice = match ? parseFloat(match[1]) : null;
        if (vetoPrice) vetoPriceSrc = 'thesis_regex';
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
      // 🟢 PUSH AL2 — TF pair hoisted to for-body scope (Path B stamps early for the
      // PENDING row; Path A leaves null → AA stamp block below runs the lookup).
      let macroTf = null, triggerTf = null;
      // AG1: strategy-true sim outputs (Path B only)
      let simExitPrice = null, simExitTime = null, simExitReason = null;
      let simPnlPts = null, simPnlUsd = null, simBars = null, simParamsJson = null;
      // 🟢 PUSH AM27 — paramsContext hoisted to for-body scope (same class of bug
      // as AM26: Path B declared it, shared tail reads it). Path B assigns;
      // Path A leaves null — correct for real-trade-graded rows.
      let paramsContext = null;

      // 🟢 AL4 — Path A gate: a live sim ticket (PENDING in this sweep's map, or
      // inserted earlier) means the veto is sim-only — a real trade close must
      // NOT re-grade it (real SLP trade hijacked 3 shadow rows mid-sim). PENDING
      // scans fall through to Path B: map-hit skips re-insert, the sim continues
      // to its own exit and updates the ticket once. Real-trade outcomes stay in
      // trade_logs — the real book is a separate ledger.
      if (matchingTrade && matchingTrade.entry_price && !pendingByScanId.has(scan.id)) {
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
        // 🟢 PUSH AL: the row is no longer SKIPPED until resolution — a PENDING ticket
        // is inserted on first sight (LIVE on chart), then UPDATED when the sim
        // resolves (exit hit) or the horizon is reached.
        const startMs = new Date(vetoTime).getTime();

        // 🟢 PUSH AL — fillBasis computed EARLY (needs only signalDirection +
        // best_bid/ask from the paired signal's telemetry) so the PENDING row can
        // carry it before any candle fetch.
        let farEntry = vetoPrice;
        fillBasis = 'mid_legacy';
        let lt = signal?.telemetry || {};
        if (typeof lt === 'string') { try { lt = JSON.parse(lt); } catch (e) { lt = {}; } }
        const bestAsk = parseFloat(lt.best_ask) || null;
        const bestBid = parseFloat(lt.best_bid) || null;
        if (signalDirection === 'BUY' && bestAsk) { farEntry = bestAsk; fillBasis = 'far_side'; }
        if (signalDirection === 'SELL' && bestBid) { farEntry = bestBid; fillBasis = 'far_side'; }

        const simParams = await fetchStrategySimParams(scan.tenant_id, scan.strategy, asset);

        // 🟢 PUSH AM4 — replay the AGENT'S adjusted parameters, not config defaults.
        // The veto telemetry carries decision_tp_price/sl_price/tripwire_percent/
        // trail_step_percent (stamped by hermes-brain.js). 🟢 AM6a: tp/sl are PRICE
        // fractions (no × leverage) — runShadowSim consumes them as price fractions
        // directly. Sanity gate: 0 < f < 0.5.
        let tp = simParams.tp, sl = simParams.sl;
        let tripwire = simParams.tripwire, trailStep = simParams.trailStep;
        let paramSource = 'config_default';
        let agentTpPrice = null, agentSlPrice = null;
        const dTp = parseFloat(telemetry.decision_tp_price);
        const dSl = parseFloat(telemetry.decision_sl_price);
        if (Number.isFinite(dTp) && farEntry) {
          const f = Math.abs(dTp - farEntry) / farEntry;
          if (f > 0 && f < 0.5) {
            tp = f; // price fraction — AM6a (no × lev)
            paramSource = 'agent_adjusted';
            agentTpPrice = dTp;
          }
        }
        if (Number.isFinite(dSl) && farEntry) {
          const f = Math.abs(dSl - farEntry) / farEntry;
          if (f > 0 && f < 0.5) {
            sl = f; // price fraction — AM6a (no × lev)
            paramSource = 'agent_adjusted';
            agentSlPrice = dSl;
          }
        }
        const dTr = parseFloat(telemetry.decision_tripwire_percent);
        if (Number.isFinite(dTr) && dTr > 0 && dTr < 1) { tripwire = dTr; paramSource = 'agent_adjusted'; }
        const dTrl = parseFloat(telemetry.decision_trail_step_percent);
        if (Number.isFinite(dTrl) && dTrl > 0 && dTrl < 0.5) { trailStep = dTrl; paramSource = 'agent_adjusted'; }
        const mergedSimParams = { ...simParams, tp, sl, tripwire, trailStep, paramSource };

        // 🟢 AM7 — params at close (config-as-truth + agent diff). Stamped on the
        // PENDING row and the resolution writes alongside sim_params. No full
        // snapshot — the config was current at close by definition.
        // 🟢 PUSH AM27 — plain assignment (no let): for-body scoped hoist above.
        paramsContext = {
          config_id: simParams.configId ?? null,
          agent_adjusted: paramSource === 'agent_adjusted',
          tp_price: agentTpPrice,
          sl_price: agentSlPrice,
          tripwire: paramSource === 'agent_adjusted' && Number.isFinite(dTr) ? dTr : null,
          trail_step: paramSource === 'agent_adjusted' && Number.isFinite(dTrl) ? dTrl : null
        };

        // 🟢 PUSH AL — TF pair stamped early too, so the PENDING row carries it.
        // 🟢 PUSH AL2 — plain assignments (no let): variables are for-body scoped.
        macroTf = 'ANY'; triggerTf = 'ANY';
        try {
          // 🟢 AM2d — per-asset + active config only (multi-row schema).
          const { data: cfg } = await supabase.from('strategy_config')
            .select('parameters')
            .eq('tenant_id', scan.tenant_id)
            .ilike('strategy', scan.strategy)
            .eq('asset', asset)
            .eq('is_active', true)
            .limit(1);
          const p = (Array.isArray(cfg) && cfg[0]?.parameters) || {};
          macroTf = p.macro_tf || 'ANY';
          triggerTf = p.trigger_tf || 'ANY';
        } catch (e) { /* fallback ANY/ANY */ }

        // 🟢 PUSH AL — insert the PENDING ticket BEFORE the candle fetch so the
        // chart goes LIVE immediately (even if the candle fetch fails this tick).
        if (!pendingByScanId.has(scan.id)) {
          const insRow = await insertPendingTicket({
            scan, asset, signalDirection, vetoPrice, vetoRegime: vetoRegime,
            simParams: mergedSimParams, macroTf, triggerTf, fillBasis,
            tpPrice: agentTpPrice, slPrice: agentSlPrice,
            paramsContext,
            // 🟢 PUSH AM21 — config fractions for complete-at-insert backfill.
            configFracs: simParams, entrySrc: vetoPriceSrc
          });
          if (insRow && insRow.id) pendingByScanId.set(scan.id, insRow); // same-tick resolution must find it
          else if (insRow === false) continue; // open cap hit — skip entirely
        }

        // 🟢 PUSH AM21 — SELF-HEAL at re-eval: retroactively repair PENDING rows
        // born incomplete (pre-AM21 ETP/AVP tickets) BEFORE the sim call. Only
        // DB-sourced rows are healed (fresh same-tick inserts carry {id} only).
        if (pendingRow && pendingRow.id && pendingRow.verdict === 'PENDING') {
          const healNeeded = pendingRow.veto_price == null ||
            !pendingRow.sim_params?.sl_price || !pendingRow.sim_params?.tp_price;
          if (healNeeded && vetoPrice != null && Number.isFinite(parseFloat(vetoPrice))) {
            const healed = resolveTicketLevels({
              entry: vetoPrice, direction: signalDirection, configFracs: simParams,
              agentTpPrice: agentTpPrice, agentSlPrice: agentSlPrice
            });
            if (healed.entry) {
              const healedParams = {
                ...(pendingRow.sim_params || {}),
                ...mergedSimParams,
                tp_price: healed.tp_price,
                sl_price: healed.sl_price,
                entry_source: vetoPriceSrc || 'veto_price',
                sl_source: healed.sl_src || pendingRow.sim_params?.sl_source || 'config',
                tp_source: healed.tp_src || pendingRow.sim_params?.tp_source || 'config'
              };
              const { error: healErr } = await supabase
                .from('shadow_portfolio')
                .update({ veto_price: parseFloat(healed.entry.toFixed(2)), sim_params: healedParams })
                .eq('id', pendingRow.id);
              if (healErr) {
                console.error(`[SHADOW] HEAL failed ${asset} scan ${scan.id}:`, healErr.message);
              } else {
                console.log(`[SHADOW] HEALED ${asset} scan ${scan.id}: entry/sl/tp backfilled (sl=${healed.sl_src || 'none'}, tp=${healed.tp_src || 'none'})`);
                // Keep the in-memory row in sync — the AM2h resolution merge
                // below reads pendingRow.sim_params.
                pendingRow.veto_price = healed.entry;
                pendingRow.sim_params = healedParams;
              }
            }
          }
        }

        // 🟢 AM24 — stagger back-to-back fetches on the SAME tenant key (2s) to
        // smooth the request rate; different tenant keys have independent limits.
        if (lastFetchedTenantId === scan.tenant_id) {
          await sleep(SWEEP_STAGGER_MS);
        }
        lastFetchedTenantId = scan.tenant_id;
        const candleData = await fetchCounterfactualCandles(asset, vetoTime, 24, scan.tenant_id);
        if (candleData && candleData.series && vetoPrice) {
          cLow = candleData.low;
          cHigh = candleData.high;

          const atr = computeATR14(candleData.series);
          const sim = runShadowSim({
            direction: signalDirection,
            entryPrice: farEntry,
            series: candleData.series,
            simParams: { ...mergedSimParams, startMs },
            atr,
            nowMs: Date.now()
          });

          // 🟢 AM7b — name the silent skip: when a PENDING ticket re-evals and the
          // sim returns null (unresolved), log WHY with real candles in hand —
          // stop/take levels, entry, direction, param values. One line per pending
          // ticket per tick; makes horizon-stuck tickets diagnosable from logs.
          if (!sim && pendingRow) {
            const _isBuy = signalDirection === 'BUY';
            const _slDist = mergedSimParams.sl != null ? mergedSimParams.sl * farEntry : (atr != null ? 1.5 * atr : null);
            const _tpDist = mergedSimParams.tp != null ? mergedSimParams.tp * farEntry : (atr != null ? 2.0 * atr : null);
            const _stop = _slDist != null ? (_isBuy ? farEntry - _slDist : farEntry + _slDist) : null;
            const _take = _tpDist != null ? (_isBuy ? farEntry + _tpDist : farEntry - _tpDist) : null;
            console.warn(
              `[SHADOW] PENDING re-eval ${asset} scan ${scan.id}: candles=${candleData?.series?.length || 0} ` +
              `entry=${farEntry} stop=${_stop ?? 'none'} take=${_take ?? 'none'} ` +
              `sl=${mergedSimParams.sl} tp=${mergedSimParams.tp} dir=${signalDirection} → sim unresolved`);
          }

          if (!sim) {
            // 🟢 PUSH AL — Unresolved (24h horizon not reached). If a PENDING row
            // exists it stays PENDING (candle walk is stateless; re-runs next
            // tick). If missing, insert it now (idempotent path).
            if (!pendingByScanId.has(scan.id)) {
              const insRow = await insertPendingTicket({
                scan, asset, signalDirection, vetoPrice, vetoRegime: vetoRegime,
                simParams: mergedSimParams, macroTf, triggerTf, fillBasis,
                tpPrice: agentTpPrice, slPrice: agentSlPrice,
                paramsContext,
                // 🟢 PUSH AM21 — config fractions for complete-at-insert backfill.
                configFracs: simParams, entrySrc: vetoPriceSrc
              });
              if (insRow && insRow.id) pendingByScanId.set(scan.id, insRow);
              else if (insRow === false) continue; // open cap hit — skip entirely
            }
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

        // 🟢 AM2g — candle fetch failure must NEVER write a resolution. A transient
        // Coinbase failure previously degraded to a junk NEUTRAL verdict (null
        // sim_exit_reason poison). Degrade to 'stay PENDING' — retry next tick.
        if (!candleData || !candleData.series || !vetoPrice) {
          console.warn(`[SHADOW] ${asset} scan ${scan.id}: candle fetch failed — ticket stays PENDING for retry`);
          continue; // NO NEUTRAL insert/update — retry next tick
        }
      }

      // 🟢 PUSH AA: stamp the strategy's TF pair at veto time (point-in-time).
      // 🟢 PUSH AL — Path B already stamped macroTf/triggerTf early (for the PENDING
      // row); only Path A needs the lookup here.
      if (!macroTf) {
        macroTf = 'ANY'; triggerTf = 'ANY';
        try {
          // 🟢 AM2d — per-asset + active config only (multi-row schema).
          const { data: cfg } = await supabase.from('strategy_config')
            .select('parameters')
            .eq('tenant_id', scan.tenant_id)
            .ilike('strategy', scan.strategy)
            .eq('asset', asset)
            .eq('is_active', true)
            .limit(1);
          const p = (Array.isArray(cfg) && cfg[0]?.parameters) || {};
          macroTf = p.macro_tf || 'ANY';
          triggerTf = p.trigger_tf || 'ANY';
        } catch (e) { /* fallback ANY/ANY */ }
      }

      // 🟢 AK2: admission control — two-ledger truth. A row is ADMITTED only if no
      // OTHER shadow row for the same (tenant, asset) overlaps its
      // [veto_time, sim_exit_time] window. Unresolved priors count as overlapping
      // (their provisional exit is now). Config-$ series uses admitted rows only;
      // ledger + % stats + decision counts keep ALL rows.
      // 🟢 PUSH AL — shared helper; excludes the candidate's own PENDING row when
      // updating it (its provisional window would otherwise overlap itself).
      // 🟢 AM26 — pendingRow is declared at for-body scope (top of the scan
      // loop), so both Path A and Path B reach this call with it defined.
      const admitted = await computeAdmitted({
        tenantId: scan.tenant_id,
        asset,
        vetoTime,
        windowEnd: simExitTime || new Date().toISOString(),
        excludeId: pendingRow ? pendingRow.id : null
      });

      // 🟢 AM2h — grade ONLY on a real sim resolution. A ticket whose sim never
      // resolved (no exit reason) must stay PENDING, never be graded NEUTRAL —
      // that's the empty-NEUTRAL poison. NEUTRAL with a real exit (HORIZON etc.)
      // is still allowed. Path A (real-trade grading) sets tradeLogId instead.
      if (!simExitReason && !tradeLogId) {
        console.warn(`[SHADOW] ${asset} scan ${scan.id}: sim did not resolve — ticket stays PENDING`);
        continue;
      }

      // 🟢 AM2h — sim_params write hardening: merge instead of overwrite, and
      // never let an empty object wipe a previously stamped params blob.
      const mergedParams = {
        ...(simParamsJson && Object.keys(simParamsJson).length ? simParamsJson : {}),
        ...((pendingRow?.sim_params) && Object.keys(pendingRow.sim_params).length ? pendingRow.sim_params : {})
      };
      const paramsToWrite = Object.keys(mergedParams).length ? mergedParams : simParamsJson;
      console.log(`[SHADOW] Params write ${asset} scan ${scan.id}:`, JSON.stringify(paramsToWrite).slice(0, 120));
      // 🟢 PUSH AM21 — PROVENANCE LOG at resolution: a null field can never
      // again pass silently — every graded ticket names its sources.
      console.log(`[SHADOW] STAMP ${asset}: entry=${paramsToWrite.entry_source || 'n/a'} sl=${paramsToWrite.sl_source || 'n/a'} tp=${paramsToWrite.tp_source || 'n/a'} (scan ${scan.id})`);

      // 🟢 PUSH AL — resolution: if a PENDING row exists for this scan, UPDATE it
      // (verdict, amounts, sim_* fields, fill_basis, trade fields, admitted
      // re-computed with the REAL sim_exit_time). Else the existing INSERT path.
      if (pendingRow) {
        const { error: upErr } = await supabase
          .from('shadow_portfolio')
          .update({
            verdict,
            saved_amount: parseFloat(savedAmount.toFixed(4)),
            missed_amount: parseFloat(missedAmount.toFixed(4)),
            actual_move_pct: actualMovePct !== null ? parseFloat(actualMovePct.toFixed(2)) : null,
            duration_minutes: durationMinutes,
            counterfactual_low: cLow !== null ? parseFloat(cLow.toFixed(2)) : null,
            counterfactual_high: cHigh !== null ? parseFloat(cHigh.toFixed(2)) : null,
            counterfactual_direction: cDirection,
            fill_basis: fillBasis,
            trade_log_id: tradeLogId,
            trade_side: tradeSide,
            trade_pnl: tradePnl ? parseFloat(tradePnl.toFixed(4)) : null,
            conviction_score: convictionScore,
            sim_exit_price: simExitPrice !== null ? parseFloat(simExitPrice.toFixed(2)) : null,
            sim_exit_time: simExitTime,
            sim_exit_reason: simExitReason,
            sim_bars: simBars,
            sim_pnl_pts: simPnlPts !== null ? parseFloat(simPnlPts.toFixed(6)) : null,
            sim_pnl_usd: simPnlUsd !== null ? parseFloat(simPnlUsd.toFixed(2)) : null,
            sim_params: paramsToWrite,
            // 🟢 AM7 — params at close: config_id + agent diff alongside sim_params.
            params_context: paramsContext,
            admitted
          })
          .eq('id', pendingRow.id);
        if (upErr) {
          console.error(`[SHADOW] PENDING update failed for scan ${scan.id}:`, upErr.message);
        } else {
          const amount = savedAmount > 0 ? `SAVED ${savedAmount.toFixed(2)} pts` : missedAmount > 0 ? `MISSED ${missedAmount.toFixed(2)} pts` : 'NEUTRAL';
          console.log(`[SHADOW] ✅ ${asset} VETO ${scan.id} @ ${vetoTime}: ${signalDirection} → ${verdict} (${amount}) [PENDING→resolved]`);
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
            sim_params: paramsToWrite,
            saved_amount: savedAmount,
            missed_amount: missedAmount,
            actual_move_pct: actualMovePct
          });
        }
        continue;
      }

      // 4. INSERT shadow_portfolio record (no PENDING row existed — first resolution)
      const { error: insertError } = await supabase
        .from('shadow_portfolio')
        .insert([{
          tenant_id: scan.tenant_id,
          scan_id: scan.id,
          asset,
          signal_direction: signalDirection,
          conviction_score: convictionScore,
          // 🟢 AM2 — same string-price hardening as insertPendingTicket (this path
          // runs when the PENDING insert failed and the sim resolves same-tick).
          veto_price: (() => { const n = vetoPrice != null ? parseFloat(vetoPrice) : null; return n != null && !isNaN(n) ? parseFloat(n.toFixed(2)) : null; })(),
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
          sim_params: paramsToWrite,
          // 🟢 AM7 — params at close: config_id + agent diff alongside sim_params.
          params_context: paramsContext,
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
          sim_params: paramsToWrite,
          saved_amount: savedAmount,
          missed_amount: missedAmount,
          actual_move_pct: actualMovePct
        });
      }
      } catch (scanErr) {
        console.error(`[SHADOW] Scan ${scan.id} (${scan.asset}) failed — skipped:`, scanErr.message);
        continue;
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
  // AI2c: watchdog-derived fallback chain (mirrors watchdog.js L148–152 verbatim).
  // Keeps HERMES_BRAIN_URL priority if ever set; reuses the service's existing
  // HERMES_WEBHOOK_URL as fallback so deploys without the brain URL still reach
  // the autopsy endpoint instead of silently POSTing to localhost:8000.
  if (process.env.HERMES_BRAIN_URL) {
    return `${process.env.HERMES_BRAIN_URL.replace(/\/$/, '')}/api/autopsy`;
  }
  if (process.env.HERMES_WEBHOOK_URL) {
    return `${process.env.HERMES_WEBHOOK_URL.replace(/\/api\/wake\/?$/, '').replace(/\/wake\/?$/, '')}/api/autopsy`;
  }
  return 'http://localhost:8000/api/autopsy';
}

async function processShadowAutopsies() {
  if (autopsyActive) return;
  autopsyActive = true;

  try {
    // Rows labeled in the last 7 days, not yet autopsied.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from('shadow_portfolio')
      .select('id, tenant_id, scan_id, asset, signal_direction, verdict, veto_regime, macro_tf, trigger_tf, sim_exit_price, sim_exit_reason, sim_pnl_pts, sim_pnl_usd, sim_params, params_context, veto_price, veto_time')
      .is('autopsied_at', null)
      // 🟢 PUSH AL — ungraded (PENDING) tickets must NEVER be autopsied.
      .neq('verdict', 'PENDING')
      .gte('veto_time', cutoff)
      .order('id', { ascending: true })
      .limit(50);

    if (error) { console.error('[SHADOW-AUTOPSY] Query failed:', error.message); return; }
    if (!rows || rows.length === 0) return;

    console.log(`[SHADOW-AUTOPSY] Feeding ${rows.length} shadow row(s) to /api/autopsy...`);

    for (const row of rows) {
      // Cited memories live in the paired scan's telemetry (sniper.js PUSH).
      let citedMemories = null;
      let skipLegacy = false;
      try {
        const { data: scan } = await supabase
          .from('scan_results')
          .select('telemetry')
          .eq('id', row.scan_id)
          .maybeSingle();
        if (!scan) {
          skipLegacy = true; // orphan ticket — paired scan gone
        } else {
          let t = scan.telemetry || {};
          if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = {}; } }
          citedMemories = t.cited_memories || null;
          // AI3 filter: only rows with real signal content (cited memories from
          // the AI wire) earn an autopsy. Legacy/pre-AI rows mint junk rules
          // ("HTTP 429 → void") — skip + stamp so they never POST and never retry.
          if (!Array.isArray(citedMemories) || citedMemories.length === 0) skipLegacy = true;
        }
      } catch (e) {
        // transient lookup failure — leave unstamped, retry next tick
      }

      if (skipLegacy) {
        await supabase.from('shadow_portfolio')
          .update({ autopsied_at: new Date().toISOString() })
          .eq('id', row.id);
        console.log(`[SHADOW-AUTOPSY] SKIPPED_LEGACY ${row.id} (${row.asset}) — no cited_memories.`);
        continue;
      }

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
            // 🟢 AM7 — parameter-aware autopsy: config baseline + agent diff.
            params_context: row.params_context || null,
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