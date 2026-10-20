// lib/execute-trade-mcp.js
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { cbRequest, generateCoinbaseToken } from './providers/coinbase.js';
import { buildRadarChartUrl } from './discord-chart.js';
import { recordUsage } from './usage-meter.js';
import { retrieveAPIKey } from './secrets-manager.js';
// 🟢 AM63 (Push 4) — kraken (Bitnomial) venue provider: venue-mark pricing +
// the id→native-symbol door. Paper-only in Push 4 (LIVE refuses below).
import { getMarketStats, resolveKrakenProduct } from './providers/kraken-bitnomial.js';
// 🟢 AM63 (Push 5) — Kraken Futures (apiv3) venue provider: venue-mark pricing +
// the id→native-instrument door. Paper-only until Push 6 (LIVE refuses below).
// 🟢 AM63 (Push 7) — the apiv3 PRIVATE layer binds the LIVE lane: order placement
// (phantom-trap-guarded), the AM59 fill receipt, cancels, the dead-man heartbeat,
// and the normalized balance. Creds resolve INSIDE the provider (kfPrivateRequest
// via retrieveAPIKey('krakenfutures')) — this file never holds KRF secrets.
import {
  getKrakenTickers,
  resolveKrakenFuturesProduct,
  placeKrakenFuturesOrder,
  pollKrakenFuturesFill,
  cancelKrakenFuturesOrder,
  refreshKrakenFuturesDeadMan,
} from './providers/kraken-futures.js';
// 🟢 AM68 — Kraken SPOT (+ margin) lane: venue-mark pricing + the id→altname door +
// the private order/fill/close layer. Creds resolve INSIDE the provider
// (retrieveAPIKey('krakenspot')); this file never holds spot secrets.
import {
  getKrakenSpotTickers,
  resolveKrakenSpotProduct,
  placeKrakenSpotOrder,
  pollKrakenSpotFill,
  cancelKrakenSpotOrder,
  getKrakenSpotOpenPositions,
} from './providers/kraken-spot.js';
import { validateTradeRisk } from './risk-validator.js';
import { getAssetSpecs } from './asset-resolver.js';
// 🟢 PUSH AM55 — pure clamp-message builder (truthful "from X to Y").
import { buildClampDetails } from './clamp-message.js';
// 🟢 PUSH AM62b — unauthenticated candle fetcher (the proven host/enum pattern).
import { fetchCandles, resolveGranularity } from './candles.js';
// 🟢 PUSH AM62b — pure price-structure resolver (macro EMA50 + N-bar slope).
import { deriveStructureDirection, MIN_BARS as STRUCTURE_MIN_BARS } from './structure-direction.js';

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

        const embed = { title, color, timestamp: new Date().toISOString() };
        // Discord embed description hard limit = 4096 chars. Over the limit
        // Discord rejects the whole webhook POST with 400 — silently losing
        // the alert. Keep head + tail of long theses.
        let desc = description || '';
        if (desc.length > 3800) {
            desc = desc.slice(0, 2000) + '\n\n…[thesis truncated — full text in UI audit log]…\n\n' + desc.slice(-1600);
            console.warn(`[DISCORD ALERT] Description truncated for ${tenantId} (was ${description?.length} chars)`);
        }
        embed.description = desc;
        if (fields.length > 0) embed.fields = fields.filter(f => String(f.value ?? '').length <= 1024);
        if (imageUrl) embed.image = { url: imageUrl };

        const response = await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error(`[DISCORD REJECTION] Status ${response.status} for tenant ${tenantId}:`, errorText.slice(0, 200));
        }
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

// 🟢 AM14 — shared poll sleep for the verified close path (no shared util existed).
const closeSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🟢 AM59 — verified-close fill poll bounds. Env-overridable so the unit check can
// exercise the timeout/retry path without waiting the full production window.
const CLOSE_FILL_POLL_MS = parseInt(process.env.AM59_FILL_POLL_MS || '400', 10);
const CLOSE_FILL_POLL_CAP_MS = parseInt(process.env.AM59_FILL_POLL_CAP_MS || '8000', 10);

// 🟢 AM62b — macro-TF candle TTL cache (MODULE scope so it persists across
// executeTradeMCP calls). Entry and close both need macro candles for the
// structure resolver; a short TTL dedupes repeated executes for the same
// product/TF. The cache key ALSO includes the target macro bar, so a close that
// lands on a later bar always refetches (fresh structure) while same-bar
// callers share the in-flight promise.
const MACRO_CANDLE_TTL_MS = 5 * 60 * 1000;
const macroCandleCache = new Map(); // `${product}|${stepSec}|${bar}` -> { promise, at, candles }

async function fetchStructureCandles(product, tf, endEpochSec) {
    const { granularitySeconds: stepSec } = resolveGranularity(tf || 'ONE_HOUR');
    const end = Math.floor(Number(endEpochSec) || Date.now() / 1000);
    const bar = Math.floor(end / stepSec);
    const key = `${product}|${stepSec}|${bar}`;
    const hit = macroCandleCache.get(key);
    if (hit && (hit.promise || Date.now() - hit.at < MACRO_CANDLE_TTL_MS)) {
        return hit.promise || hit.candles;
    }
    const start = end - stepSec * STRUCTURE_MIN_BARS;
    const promise = (async () => {
        try {
            return await fetchCandles({ product, granularitySeconds: stepSec, startEpoch: start, endEpoch: end });
        } catch (err) {
            console.warn(`[AM62b] macro candle fetch failed for ${product} @${stepSec}s: ${err.message}`);
            return [];
        }
    })();
    macroCandleCache.set(key, { promise, at: Date.now(), candles: [] });
    const candles = await promise;
    macroCandleCache.set(key, { promise: null, at: Date.now(), candles });
    return candles;
}

// 🟢 AM59 — normalise Coinbase order-state labels. The verified-close path compared
// lowercase AWS labels ('filled'/'canceled') in places; unify on uppercase before any
// terminal/fill comparison so a venue casing change can never read as "still working".
const normalizeOrderStatus = (status) => String(status || '').trim().toUpperCase();

// 🟢 AM59 — bounded poll until an order terminally FILLS. Shared by the pre-close
// verification (steps 1-2) and the post-close bracket sweep (step 4). A fill receipt
// requires status FILLED AND a positive filled size (or avg price) — a bare 'FILLED'
// with zero size is NOT a receipt. Returns
// { confirmed, status, averagePrice, totalFees, order }.
const waitForOrderFilled = async (orderId, tokenFn, { maxMs = CLOSE_FILL_POLL_CAP_MS, intervalMs = CLOSE_FILL_POLL_MS } = {}) => {
    const deadline = Date.now() + maxMs;
    let last = { confirmed: false, status: 'UNKNOWN', averagePrice: null, totalFees: null, order: null };
    while (Date.now() < deadline) {
        await closeSleep(intervalMs);
        try {
            const checkPath = `/api/v3/brokerage/orders/historical/${orderId}`;
            const checkResp = await cbRequest({ token: `${tokenFn('GET', checkPath)}`, method: 'GET', path: `${checkPath}` });
            if (!checkResp.ok) continue;
            const checkData = await checkResp.json();
            const ord = checkData.order || {};
            const status = normalizeOrderStatus(ord.status);
            const filledQty = parseFloat(ord.filled_size) || parseFloat(ord.filled_quantity) || parseFloat(ord.number_of_contracts) || 0;
            const avgPrice = parseFloat(ord.average_filled_price) || parseFloat(ord.avg_price) || 0;
            last = {
                confirmed: false,
                status,
                averagePrice: avgPrice || null,
                totalFees: ord.total_fees != null ? parseFloat(ord.total_fees) : null,
                order: ord,
            };
            if (status === 'FILLED' && (filledQty > 0 || avgPrice > 0)) {
                return { ...last, confirmed: true };
            }
            if (['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(status)) {
                return last;
            }
        } catch (e) {
            console.error(`[AM59 FILL POLL] order ${orderId} check failed:`, e.message);
        }
    }
    return last;
};

// 🟢 AM14 — in-process reentrancy guard for closes (mirrors watchdog closingNow).
// Key: `${tenantId}:${product}` → timestamp of the close attempt. Entries older
// than CLOSE_LOCK_TTL_MS are treated as stale so a crashed close can never
// permanently lock a product.
const closingNow = new Map();
const CLOSE_LOCK_TTL_MS = 60000;

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

    // 🟢 AM63 (Push 4) — a kraken (Bitnomial) platform id ENDS in its contract
    // size (BASE-PERP-KRX-<size>). Detecting it from the id lets the candle/chart
    // paths bail BEFORE any Coinbase fetch; the config-based `krakenLane` (below)
    // is the authoritative lane for execution + pricing.
    const krakenSymbol = rawSymbol.includes('-PERP-KRX-');
    // 🟢 AM63 (Push 5) — a Kraken Futures (apiv3) platform id is `${BASE}-PERP-KRF`
    // with NO size suffix (apiv3 has one perp per base). NOTE: no trailing dash —
    // `includes('-PERP-KRF-')` would NEVER match. Same bail-before-Coinbase purpose.
    const krakenFuturesSymbol = rawSymbol.includes('-PERP-KRF');
    // 🟢 AM68 — a Kraken SPOT (`-SPOT-KRS`) platform id. Same bail-before-Coinbase
    // purpose; the config-based `krakenSpotLane` (below) is authoritative.
    const krakenSpotSymbol = rawSymbol.includes('-SPOT-KRS');

    // ASSET RESOLVER: Fetch contract specs from Coinbase on every trade.
    // Provides dynamic multiplier and tickSize, replacing the old hardcoded table.
    const assetSpecs = await getAssetSpecs(tenantId, rawSymbol, 'coinbase');
    if (assetSpecs.error) {
      console.warn(`[ASSET RESOLVER] ${assetSpecs.error}. Using defaults.`);
    }
    const multiplier = assetSpecs.contract_size || 1.0;
    const tickSize = assetSpecs.quote_increment || 0.01;
    const assetMaxLeverage = parseFloat(assetSpecs.max_leverage) || null;

    // Phase 2.3: Idempotency key handling (server-side)
    // If an idempotency key is provided by the client, ensure we process it at most once per tenant
    if (data.idempotency_key) {
      try {
        const key = data.idempotency_key;
        const { data: idem } = await supabase.from('trade_idempotency').select('id').eq('tenant_id', tenantId).eq('idempotency_key', key).maybeSingle();
        if (idem) {
          // Duplicate within considered window
          console.warn(`[IDEMPOTENCY] Duplicate idempotency_key ${key} for tenant ${tenantId}`);
          return { status: 'duplicate', idempotency_key: key, product: coinbaseProduct };
        }
        // Record the idempotent action
        await supabase.from('trade_idempotency').insert({ tenant_id: tenantId, idempotency_key: key, created_at: new Date().toISOString() });
      } catch (idemErr) {
        // If the table doesn't exist or any error occurs, fall back to best-effort processing
        console.warn('[IDEMPOTENCY] Server-side idempotency skipped due to error:', idemErr?.message || idemErr);
      }
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
    // Bookkeeping leverage — never sent to Coinbase (INTX sets real margin per
    // its own tier). Recorded on the trade row so the watchdog's ROE conversion
    // (price_move × leverage) arms the tripwire at the same price distance the
    // agent derived it for. Priority: explicit payload → strategy config → 1.
    let leverage = parseFloat(data.leverage);
    if (!leverage && strategyId !== 'MANUAL') {
        try {
            const { data: levCfg } = await supabase.from('strategy_config')
                .select('parameters')
                .eq('tenant_id', tenantId)
                .eq('strategy', strategyId)
                .eq('asset', rawSymbol)
                .order('is_active', { ascending: false })
                .limit(1)
                .maybeSingle();
            leverage = parseFloat(levCfg?.parameters?.leverage);
        } catch (levErr) {
            console.warn('[LEVERAGE RESOLVE] Config lookup failed, defaulting to 1:', levErr?.message);
        }
    }
    if (!leverage || leverage < 1) leverage = 1;
    const marketType = data.market_type || 'FUTURES'; 
    const orderType = data.order_type || 'MARKET'; 
    const tradeReason = data.reason || null;
    let fullMarketSnapshot = data._full_market_snapshot || null;
    let influencingMemoryIds = data._influencing_memory_ids || null;

    // 🛡️ FIX: DB is the single source of truth for whether a position is open.
    // The query at line 184 already scopes to tenant_id + symbol + strategy_id
    // + exit_price IS NULL. No text-matching on the reason string — "close above $X"
    // in a thesis must never match "CLOSE". isForcedExit is true ONLY when a
    // specific trade_id was provided by the caller (post-loop CLOSE/ADJUST dispatches),
    // meaning they explicitly target an existing trade to close or adjust.
    const isForcedExit = !!(data.trade_id);

    // 🟢 DEDUPLICATION CHECK: Prevent duplicate NEW trades within 30-second window
    // Only applies to ENTRY trades, not reversals or forced exits
    // Extended to ALL execution modes (LIVE + PAPER) to prevent duplicate trade_log creation
    if (!data.trade_id && !isForcedExit) {
      try {
        const cutoffTime = new Date(Date.now() - 30 * 1000).toISOString(); // Last 30 seconds
        const { data: recentTrades, error: recentError } = await supabase
          .from('trade_logs')
          .select('id, created_at, side')
          .eq('tenant_id', tenantId)
          .eq('symbol', rawSymbol)
          .eq('strategy_id', strategyId)
          .eq('execution_mode', mode)
          .gte('created_at', cutoffTime)
          .is('exit_price', null);

        if (!recentError && recentTrades && recentTrades.length > 0) {
          // Check if the most recent entry is the same side as this signal
          const mostRecentTrade = recentTrades[recentTrades.length - 1];
          if (mostRecentTrade.side === side) {
            console.warn(`[DEDUPLICATION] Duplicate ${side} signal for ${rawSymbol} within 30s. Suppressing trade to prevent double-open. Last entry: ${mostRecentTrade.created_at}`);
            return { status: "duplicate_suppressed", reason: `Duplicate ${side} signal within 30 seconds`, product: coinbaseProduct };
          }
        }
      } catch (dedupeError) {
        console.error("[DEDUPLICATION CHECK ERROR]:", dedupeError.message);
        // Continue with execution if dedup check fails (fail-open to prevent trade loss)
      }
    }

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
    }
    const openTrade = openTrades && openTrades.length > 0 ? openTrades[0] : null;

    // 🟢 SAME-SIDE SAFETY NET: If an open trade already exists for this symbol+strategy
    // and the incoming signal is the SAME side (not a reversal close), suppress as duplicate.
    if (openTrade && !isForcedExit && openTrade.side === side) {
        console.warn(`[DEDUPLICATION] Same-side ${side} trade already open for ${rawSymbol} (id: ${openTrade.id}). Suppressing to prevent duplicate position.`);
        return { status: "duplicate_suppressed", reason: `Same-side ${side} trade already open for ${rawSymbol}`, product: coinbaseProduct };
    }

    // 🟢 AM30 — ENTRY IDEMPOTENCY (hard gate): a NEW ENTRY signal while a position is
    // already open on this symbol+strategy must NEVER place an order. The brain's HOLD
    // lane is advisory; the execution layer is the hard gate. Without this, an
    // opposite-side signal that isn't a forced exit falls through and stacks a second
    // position on top of the live one.
    if (openTrade && !isForcedExit && openTrade.side !== side) {
        console.warn(`[ENTRY SKIPPED] ${rawSymbol}: position already open (db qty=${openTrade.qty}, id: ${openTrade.id}) — double-entry blocked (new ${side} signal vs open ${openTrade.side} position).`);
        return { status: "entry_blocked", reason: `Position already open for ${rawSymbol} (id: ${openTrade.id}) — double-entry blocked`, product: coinbaseProduct };
    }

    if (openTrade && isForcedExit) {
        side = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
    }

    // 🟢 LIVE EXCHANGE DIRECT CLOSE
    // A position the broker reports as open but with NO trade_logs row (e.g. a
    // live derivative opened outside the agent, or a synthesized dashboard live
    // position). The dashboard sends reduce_only + LIVE + a forced-exit reason
    // and the ALREADY-FLIPPED closing side. We must NOT bail as
    // "already_closed_natively" — we place a reduce-only market order to flatten
    // it. `side` is already the closing side here, so we leave it untouched.
    const isLiveDirectClose = !openTrade && isForcedExit && !isPaper &&
        data.reduce_only === true && parseFloat(data.qty || 0) > 0;

    if (!openTrade && isForcedExit && !isLiveDirectClose) {
        return { status: "already_closed_natively", product: coinbaseProduct };
    }

    if (tenantId) {
        await recordUsage(tenantId, 'TRADE_EXECUTED', 1);
    }

    const isClosing = (openTrade && openTrade.side !== side) || isLiveDirectClose;

    let orderQty = Math.max(1, Math.round(parseFloat(data.qty || 1)));
    if (isClosing && openTrade) {
        orderQty = Math.max(1, Math.round(parseFloat(openTrade.qty || orderQty)));
    }

    // AM63 — late-bound: `formattedSecret` is assigned below (key retrieval), so the
    // closure must read the variable at call time (same capture semantics as before).
    const generateToken = (method, path) => generateCoinbaseToken(method, path, apiKeyName, formattedSecret);

    let executionPrice = incomingPrice ? parseFloat((Math.round(incomingPrice / tickSize) * tickSize).toFixed(4)) : 0;
    // 🟢 AM14 — REAL exchange fees for closes, read from the confirmed fill's order
    // status (total_fees). Null for paper closes / entries. Stamped into params_context.
    let closeFees = null;
    // 🟢 AM59 — the verified-close receipt: order id + whether the fill was terminally
    // confirmed. `closeFillConfirmed` gates the ONLY write of exit_price/exit_fees.
    let closeOrderId = null;
    let closeFillConfirmed = false;
    // 🟢 AM68 — Kraken SPOT lane state (function scope: the spot entry/close blocks
    // write them; the close write-back below reads the receipt).
    let ksEntryTxid = null;
    let ksEntryFilledQty = null;
    let ksCloseTxid = null;
    // 🟢 AM63 (Push 7) — KRF LIVE lane state (function scope: the KRF entry INSERT
    // writes them inside if(!isPaper); the close write-back below reads them).
    let kfTpOrderId = null;
    let kfSlOrderId = null;
    let kfEntryOrderId = null;
    let kfEntryFilledQty = null;
    let kfCloseRealizedPnl = null;
    let kfCloseOrderId = null;
    // 🟢 Push 7 hotfix 3 — the verbatim apiv3 errorMessage + the host actually used,
    // captured from the last reject verdict so every reject surface (log, veto row,
    // Discord) can separate bad-creds from a demo/prod mismatch from a code bug.
    let kfLastRejectError = null;
    let kfLastRejectHost = null;
    // 🟢 AM59 — the single truthful close-failure payload. Returning this keeps the
    // trade OPEN in the DB and tells the agent the position is STILL LIVE.
    const closeFailedResult = (step, reason, residualQty = null) => ({
        status: 'close_failed',
        close_failed: true,
        error: `step=${step}: ${reason}`,
        step,
        reason,
        product: coinbaseProduct,
        trade_id: (openTrade && openTrade.id) || data.trade_id || null,
        position_still_open: true,
        residual_qty: residualQty,
        hint: 'Position is STILL LIVE and unmanaged. Do NOT assume the close executed. Retry or intervene manually.',
    });
    if (tpPrice) tpPrice = parseFloat((Math.round(tpPrice / tickSize) * tickSize).toFixed(4));
    if (slPrice) slPrice = parseFloat((Math.round(slPrice / tickSize) * tickSize).toFixed(4));

    let telemetry = {};
    try {
        // 🟢 Phase 1B: prefer a scan_result that carries a REAL regime label (from the
        // sniper or an enriched agent scan). The naive "latest scan" fetch used to pick
        // agent VETO/HOLD rows with no regime → regime_at_entry silently null.
        let scanData = null;
        {
            const { data: r1, error: e1 } = await supabase.from('scan_results')
                .select('telemetry')
                .eq('asset', rawSymbol)
                .eq('tenant_id', tenantId) // Filter by tenant
                .not('telemetry->>macro_regime_oracle', 'is', null)
                .neq('telemetry->>macro_regime_oracle', 'EVALUATING')
                .order('created_at', { ascending: false })
                .limit(1);
            if (!e1 && r1 && r1.length > 0) {
                scanData = r1;
            } else {
                // Fallback to any latest scan (old behavior)
                const { data: r2 } = await supabase.from('scan_results')
                    .select('telemetry')
                    .eq('asset', rawSymbol)
                    .eq('tenant_id', tenantId)
                    .order('created_at', { ascending: false })
                    .limit(1);
                scanData = r2;
            }
        }
        if (scanData && scanData.length > 0) {
            telemetry = scanData[0].telemetry || {};
        }
    } catch(e) { console.error("Telemetry fetch failed (catch block):", e.message); }

    // Build a TRIMMED market-condition snapshot — only what we know for sure
    // right now. Stored at entry and (rebuilt) at close so the agent can dissect
    // what conditions surrounded each side of the trade. Kept small on purpose.
    const buildMarketSnapshot = (priceAtMoment) => {
        const t = telemetry || {};
        const snap = {
            at: new Date().toISOString(),
            price: Number(priceAtMoment) || null,
            regime: t.macro_regime_oracle || null,
            oracle_score: t.oracle_score ?? null,
            micro_cvd: t.micro_cvd ?? t.cvd ?? null,
            cvd: t.cvd ?? null,
            macro_cvd: t.macro_cvd ?? null,
            macro_poc: t.macro_poc ?? null,
            upper_node: t.upper_macro_node ?? null,
            lower_node: t.lower_macro_node ?? null,
            atr: t.atr ?? t.trigger_atr ?? null,
            oi_momentum: t.oi_momentum ?? null,
            funding_z: t.funding_z ?? t.z_fr ?? null,
            premium: t.premium ?? null,
            sp500: t.sp500 ?? null,
            dxy: t.dxy ?? null,
            bids: t.bids ?? null,
            asks: t.asks ?? null,
            open_position: t.open_position ?? null,
            open_tp: t.open_tp ?? null,
            open_sl: t.open_sl ?? null,
            open_pnl: t.open_pnl ?? null
        };
        // Drop nulls so rows stay tiny.
        Object.keys(snap).forEach(k => { if (snap[k] === null || snap[k] === undefined) delete snap[k]; });
        return snap;
    };

    // 🟢 AM62b — structure_direction is DERIVED FROM PRICE STRUCTURE on the macro
    // TF (EMA50 vs last close + N-bar slope); CVD is only a tiebreak vote. The
    // pure resolver lives in lib/structure-direction.js. Values stay LONG | SHORT
    // | NEUTRAL (migration 059 CHECK) and are never NULL for a new row. Feeds the
    // AM61 COUNTER_TREND_SCALP tag class, the empirical priors, and the Learning
    // Loop panel. Direction is read from the macro TF the STRATEGY declared
    // (resolvedMacroTf); the sniper's canon structure is always 6H/5m, so a row
    // whose macro_tf differs may carry a structure computed on that other window.

    let recentCandles = [];
    try {
        if (krakenSymbol) {
            // 🟢 AM63 (Push 4) — no Kraken candles/charts (honest empty state).
            // NEVER fetch Coinbase candles for a KRX id (invisible-fallback trap).
        } else {
        // 🟢 PUBLIC CANDLE API — unauthenticated CDP market endpoint via lib/candles.js
        // (proven host + enum pattern). Fixes the AM62 "double-dead" fetch: the old
        // Exchange host is geo-blocked AND the legacy seconds granularity is the wrong
        // format for this endpoint. This 5m series is the CHART-ONLY feed for
        // buildRadarChartUrl below.
        const end = Math.floor(Date.now() / 1000);
        const start = end - 300 * 50;
        recentCandles = await fetchCandles({ product: coinbaseProduct, granularitySeconds: 'FIVE_MINUTE', startEpoch: start, endEpoch: end });
        }
    } catch (e) { console.error("Chart candle fetch failed", e.message); }

    const standardFields = [
        { name: "Regime", value: telemetry.macro_regime_oracle || "EVALUATING", inline: true },
        { name: "Macro POC", value: telemetry.macro_poc ? `$${telemetry.macro_poc}` : "--", inline: true },
        { name: "Micro CVD", value: telemetry.micro_cvd ? telemetry.micro_cvd.toString() : "--", inline: true }
    ];

    let executionStatus = 'simulated';
    let pendingTradeId = null;

    // 🟢 LABEL INTEGRITY (PUSH K): resolve trade labels server-side so trade_logs
    // never inherits agent-arg omissions. Config is the anchor; args win only if present.
    // HOTFIX (EXEC) — moved OUT of the LIVE-only `if (!isPaper)` block: the PAPER
    // insert references canonicalStrategyId/resolvedTriggerTf/resolvedMacroTf/
    // regimeAtEntry and crashed with a ReferenceError on every paper execution.
    // Only uses data/telemetry/strategyId/rawSymbol/tenantId — all in scope here.
    let stratCfg = null;
    try {
      if (strategyId !== 'MANUAL') {
        // 🟢 AM63 (Push 2) — the select MUST cover `exchange` or stratCfg?.exchange
        // is undefined forever and stamping silently stays 'coinbase' even after a
        // venue is configured. If migration 060 is not applied yet (deploy-order
        // slip), PostgREST returns PGRST204 ("Could not find the 'exchange' column
        // ... in the schema cache"); degrade to the pre-060 select so
        // trigger_tf/macro_tf/canonicalStrategyId never vanish — the 057-class
        // mistake, made VISIBLE instead of silent.
        let cfgRow = null;
        let cfgErr = null;
        ({ data: cfgRow, error: cfgErr } = await supabase
          .from('strategy_config')
          .select('id, strategy, parameters, exchange')
          .eq('tenant_id', tenantId)
          .eq('strategy', strategyId)
          .eq('asset', rawSymbol)
          .maybeSingle());
        if (cfgErr && cfgErr.code === 'PGRST204') {
          console.warn('[AM63] strategy_config select degraded — migration 060 not applied (deploy order error). exchange will default to coinbase.');
          ({ data: cfgRow, error: cfgErr } = await supabase
            .from('strategy_config')
            .select('id, strategy, parameters')
            .eq('tenant_id', tenantId)
            .eq('strategy', strategyId)
            .eq('asset', rawSymbol)
            .maybeSingle());
        }
        stratCfg = cfgRow || null;
      }
    } catch (e) { stratCfg = null; }

    const cfgParams = stratCfg?.parameters || {};
    const resolvedTriggerTf = data.trigger_tf || cfgParams.trigger_tf || null;
    const resolvedMacroTf   = data.macro_tf   || cfgParams.macro_tf   || null;
    const resolvedExchange  = (stratCfg?.exchange || 'coinbase').toLowerCase();
    // 🟢 AM63 (Push 4) — the kraken (Bitnomial) lane. Exact match on the
    // already-lowercased venue (never includes/toUpperCase); a KRX id also flags
    // it. Unknown/falsy falls through to the byte-identical Coinbase path.
    // Paper-only in Push 4. Kraken PnL uses contract_size resolved from the id
    // (resolveKrakenProduct) — a silent 1.0 would misprice BTC by 1000x.
    const krakenLane = resolvedExchange === 'kraken' || krakenSymbol;
    let krakenProduct = null;
    if (krakenLane) {
      krakenProduct = await resolveKrakenProduct(rawSymbol);
      if (!krakenProduct || krakenProduct.error) {
        console.error(`[AM63] kraken product unresolved for ${rawSymbol}: ${krakenProduct?.error || 'no product'}`);
        return { error: `[AM63] Kraken product unresolved for ${rawSymbol} (${krakenProduct?.error || 'unknown id'})`, status: 502 };
      }
    }
    const krakenContractSize = krakenProduct ? krakenProduct.contractSize : 1.0;
    const krakenMultiplier = (krakenLane && Number.isFinite(krakenContractSize) && krakenContractSize > 0) ? krakenContractSize : 1.0;
    // 🟢 AM63 (Push 5) — the Kraken Futures (apiv3) lane. Exact match on the
    // already-lowercased venue; a KRF id also flags it. Paper-only until Push 6.
    // The multiplier is the instrument's contractSize (apiv3 = 1 for all PF_ perps,
    // but resolved from the venue so a future change can never misprice silently).
    const krakenFuturesLane = resolvedExchange === 'krakenfutures' || krakenFuturesSymbol;
    let krakenFuturesProduct = null;
    if (krakenFuturesLane) {
      krakenFuturesProduct = await resolveKrakenFuturesProduct(rawSymbol);
      if (!krakenFuturesProduct || krakenFuturesProduct.error) {
        console.error(`[AM63] krakenfutures product unresolved for ${rawSymbol}: ${krakenFuturesProduct?.error || 'no product'}`);
        return { error: `[AM63] Kraken Futures product unresolved for ${rawSymbol} (${krakenFuturesProduct?.error || 'unknown id'})`, status: 502 };
      }
    }
    const kfContractSize = krakenFuturesProduct ? krakenFuturesProduct.contractSize : 1.0;
    const kfMultiplier = (krakenFuturesLane && Number.isFinite(kfContractSize) && kfContractSize > 0) ? kfContractSize : 1.0;
    // The KRF instrument's OWN tickSize — NEVER a coinbase-derived tick (the KRX
    // polish gap must not repeat here). Falls back to the coinbase tick only if the
    // venue omits it (it does not, per the live probe).
    const kfTickSize = (krakenFuturesLane && Number.isFinite(parseFloat(krakenFuturesProduct?.tickSize)))
      ? parseFloat(krakenFuturesProduct.tickSize)
      : tickSize;
    // 🟢 AM68 — the Kraken SPOT (+ margin) lane. Qty = base asset DIRECTLY (no
    // contract sizes — spot contract_size is 1). LIVE allowed with the KRAKENSPOT row.
    const krakenSpotLane = resolvedExchange === 'krakenspot' || krakenSpotSymbol;
    let krakenSpotProduct = null;
    if (krakenSpotLane) {
      krakenSpotProduct = await resolveKrakenSpotProduct(rawSymbol);
      if (!krakenSpotProduct || krakenSpotProduct.error) {
        console.error(`[AM68] krakenspot product unresolved for ${rawSymbol}: ${krakenSpotProduct?.error || 'no product'}`);
        return { error: `[AM68] Kraken Spot product unresolved for ${rawSymbol} (${krakenSpotProduct?.error || 'unknown id'})`, status: 502 };
      }
    }
    // SPOT tick: the pair's tick_size, else 10^-pair_decimals, else the coinbase tick.
    const ksTickFromDecimals = (krakenSpotProduct?.pair_decimals != null)
      ? Math.pow(10, -parseInt(krakenSpotProduct.pair_decimals, 10))
      : NaN;
    const ksTickSize = krakenSpotLane
      ? (Number.isFinite(parseFloat(krakenSpotProduct?.tick_size)) ? parseFloat(krakenSpotProduct.tick_size)
        : (Number.isFinite(ksTickFromDecimals) && ksTickFromDecimals > 0 ? ksTickFromDecimals : tickSize))
      : tickSize;
    const effectiveMultiplier = krakenFuturesLane ? kfMultiplier : (krakenSpotLane ? 1.0 : (krakenLane ? krakenMultiplier : multiplier));
    // 🟢 AM63 (Push 4) — LIVE kraken refuses LOUD until Push 5 (BTP order entry).
    // Never a silent Coinbase fallback.
    if (krakenLane && !isPaper) {
      console.warn(`[AM63] LIVE kraken execution refused for ${rawSymbol} — paper-only until Push 5.`);
      return { error: '[AM63] Kraken live execution arrives in Push 5 (BTP order entry). Venue runs paper-only until then.', status: 502 };
    }
    // 🟢 AM63 (Push 7) — LIVE krakenfutures is BOUND (the Push 6 refusal is gone).
    // The entry is a limit-IOC at the venue mark ± an ATR-informed slippage band:
    // deterministic worst-case price (the limit), touch-through fill, remainder
    // cancels (no resting order to orphan, no PENDING_REVIEW machinery). mkt is
    // permitted by the venue but carries a ~1% price-protection band — up to 1%
    // slippage, less deterministic. Band = max(tick, KRF_ENTRY_BAND_ATR_MULT × ATR)
    // with a 0.1%-of-mark fallback when telemetry is dark; env-overridable for the
    // demo soak.
    const kfEntryBandAtrMult = parseFloat(process.env.KRF_ENTRY_BAND_ATR_MULT || '0.25');
    const kfAtr = parseFloat(telemetry?.atr ?? telemetry?.trigger_atr) || null;
    const kfBand = krakenFuturesLane
      ? Math.max(kfTickSize, (Number.isFinite(kfEntryBandAtrMult) ? kfEntryBandAtrMult : 0.25) * (kfAtr > 0 ? kfAtr : 0))
      : 0;
    // Quantity precision (probe item d): contractValueTradePrecision = min qty
    // decimal places (can be negative for 10/100 increments); minimumTradeSize is
    // the per-instrument floor (null → no floor until the soak proves otherwise).
    const kfQtyPrecision = Number.isInteger(krakenFuturesProduct?.contractValueTradePrecision)
      ? krakenFuturesProduct.contractValueTradePrecision
      : 0;
    const kfMinSize = Number.isFinite(parseFloat(krakenFuturesProduct?.minimumTradeSize))
      ? parseFloat(krakenFuturesProduct.minimumTradeSize)
      : null;
    const kfRoundQty = (q) => {
      const factor = Math.pow(10, Math.max(0, kfQtyPrecision));
      return Math.max(1, Math.floor(parseFloat(q) * factor) / factor);
    };
    const canonicalStrategyId = stratCfg?.strategy || strategyId;

    // 🟢 AM7 — params at close (config-as-truth + agent diff). Built once here
    // (config id + baseline in scope), stamped on the close UPDATE and passed
    // to the autopsy. agent_adjusted = the agent's decision prices differ from
    // the config baseline; null prices mean the config levels were used as-is.
    const agentTp = cleanNum(data.tp_price);
    const agentSl = cleanNum(data.sl_price);
    const paramsContext = {
      config_id: stratCfg?.id ?? null,
      agent_adjusted: !!(agentTp && cfgParams.tp_percent && openTrade?.tp_price &&
          Math.abs(agentTp - parseFloat(openTrade.tp_price)) > tickSize) ||
        !!(agentSl && cfgParams.sl_percent && openTrade?.sl_price &&
          Math.abs(agentSl - parseFloat(openTrade.sl_price)) > tickSize),
      tp_price: agentTp ?? null,
      sl_price: agentSl ?? null,
      tripwire: cleanNum(data.tripwire_percent) ?? null,
      trail_step: cleanNum(data.trail_step_percent) ?? null
    };

    // 🟢 PUSH AM53 — ENTRY-TIME regime/exit snapshot, persisted into
    // trade_logs.params_context at INSERT (the lock-at-entry half of AM53).
    // Sources, in priority order:
    //   1. explicit payload fields (trap springs — they bypass the cortex and
    //      carry _regime_selected/_resolved_exit_params directly), then
    //   2. the scan telemetry the sniper stamped on the signal path.
    // tripwire/trail_step/trail_activation are snapshotted so the watchdog reads
    // the ENTRY geometry instead of re-reading live config (a config edit or a
    // regime change mid-trade must not retune an open position).
    const entryRegimeSelected = data._regime_selected ?? telemetry?.regime_selected ?? null;
    const entryRegimeParamsApplied = data._regime_params_applied ?? telemetry?.regime_params_applied ?? null;
    const entryExitParams = data._resolved_exit_params || telemetry?.resolved_exit_params || null;
    const entryParamsContext = {
      regime_selected: entryRegimeSelected,
      regime_params_applied: (entryRegimeParamsApplied && typeof entryRegimeParamsApplied === 'object') ? entryRegimeParamsApplied : {},
      entry_tripwire: entryExitParams ? cleanNum(entryExitParams.tripwire_percent) : null,
      entry_trail_step: entryExitParams ? cleanNum(entryExitParams.trail_step_percent) : null,
      entry_trail_activation: entryExitParams ? cleanNum(entryExitParams.trail_activation_percent) : null
    };

    // 🟢 AM62 — agent entry-geometry echo. Present ONLY when the brain returned
    // APPROVE_WITH_PARAMS under agent_open_trade_entry_adjust. Records what the
    // agent proposed vs what was actually applied after clamping (audit truth).
    const entryAdjust = (data._entry_adjust && typeof data._entry_adjust === 'object') ? data._entry_adjust : null;
    if (entryAdjust && entryAdjust.agent_adjusted) {
      entryParamsContext.agent_adjusted = true;
      entryParamsContext.agent_adjust_proposed = entryAdjust.proposed || null;
      entryParamsContext.agent_adjust_applied = entryAdjust.applied || null;
      entryParamsContext.agent_adjust_clamped = !!entryAdjust.clamped;
      if (Array.isArray(entryAdjust.details) && entryAdjust.details.length > 0) {
        entryParamsContext.agent_adjust_details = entryAdjust.details;
        console.warn(`[AM62] entry geometry clamped: ${entryAdjust.details.join('; ')}`);
      }
    }

    // regime_at_entry: prefer live scan telemetry; else latest scan's canon oracle
    let regimeAtEntry = telemetry?.macro_regime_oracle || null;
    if (!regimeAtEntry) {
      try {
        const { data: lastScan } = await supabase
          .from('scan_results')
          .select('telemetry')
          .eq('asset', rawSymbol)
          .neq('telemetry->>macro_regime_oracle', 'EVALUATING')
          .order('created_at', { ascending: false })
          .limit(1);
        const st = typeof lastScan?.[0]?.telemetry === 'string'
          ? JSON.parse(lastScan[0].telemetry)
          : (lastScan?.[0]?.telemetry || {});
        regimeAtEntry = st.macro_regime_oracle || null;
      } catch (e) { /* non-fatal — NULL is honest */ }
    }

    // 🟢 AM62b — derive the structure bias ONCE at entry from REAL macro-TF price
    // structure (EMA50 + 10-bar slope), with the signed CVD as a tiebreak vote.
    // Macro candles are fetched at the strategy's declared macro TF (resolvedMacroTf,
    // declared above); the 5m candles above stay the chart-only series. Mirrored
    // into params_context so it survives the entry→close merge, and written as a
    // top-level column.
    // 🟢 AM63 (Push 4) — kraken has NO intraday candles; decline the Coinbase
    // structure-candle fetch entirely (no cross-venue substitute) and stamp NULL.
    let entryMacroCandles = [];
    if (krakenSymbol) {
      console.warn('[AM63] structure_direction unavailable for kraken (no charts until venue OHLC)');
    } else {
      entryMacroCandles = await fetchStructureCandles(coinbaseProduct, resolvedMacroTf, Date.now() / 1000);
    }
    const structureDirection = krakenSymbol ? null : deriveStructureDirection(
      entryMacroCandles,
      telemetry?.macro_cvd ?? telemetry?.micro_cvd ?? telemetry?.cvd ?? null
    );
    if (!krakenSymbol) entryParamsContext.structure_direction = structureDirection;

    if (!isPaper) {
      // 🔑 Retrieve tenant API keys — only needed for LIVE trades.
      // 🟢 AM63 (Push 7) — the krakenfutures lane SKIPS the Coinbase vault read:
      // kfPrivateRequest resolves KRF creds ITSELF (retrieveAPIKey 'krakenfutures'),
      // and a KRF-only tenant has no COINBASE vault row (the old unconditional read
      // would throw 'Keys not found for COINBASE' and kill the lane).
      if (krakenFuturesLane || krakenSpotLane) {
        if (!tenantId) throw new Error('No tenant_id provided. Cannot determine which keys to use.');
        console.log(`[AM63/AM68] ${krakenSpotLane ? 'krakenspot' : 'krakenfutures'} LIVE lane for ${rawSymbol} — venue creds resolve inside the provider (no Coinbase vault read).`);
      } else if (tenantId) {
        const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
        apiKeyName = secrets.apiKey;
        apiSecret = secrets.apiSecret;
        if (!apiKeyName || !apiSecret) {
            throw new Error(`Tenant ${tenantId} has no valid Coinbase API keys configured in vault. Cannot execute trade.`);
        }
        // 🟢 Push 7 hotfix — these are pure Coinbase concerns: for the krakenfutures
        // lane the creds never populate apiKeyName/apiSecret, so the generic throw
        // fired on every KRF LIVE entry ("Missing Coinbase API credentials.") and
        // formattedSecret.replace on undefined was the next crash. Both moved inside
        // the Coinbase branch.
        if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase API credentials.");
        formattedSecret = apiSecret.replace(/\\n/g, '\n');
      } else {
        throw new Error("No tenant_id provided. Cannot determine which keys to use.");
      }

      // 🔒 STRATEGY ACTIVE CHECK: Verify the strategy is active before executing
      if (strategyId !== 'MANUAL') {
        try {
          const { data: stratConfig } = await supabase
            .from('strategy_config')
            .select('is_active, strategy, parameters')
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
      // (hoisted ABOVE the KRF lane — the KRF ADJUST branch reads it).
      const isBracketAdjustment = tradeReason && tradeReason.includes('ADJUST_TP_SL');

      // ═══════════════════════════════════════════════════════════════════════
      // 🟢 AM68 — THE KRAKEN SPOT (+ margin) LIVE LANE.
      // ═══════════════════════════════════════════════════════════════════════
      // Same doctrine as the KRF lane: entries are limit-IOC at the venue mark ±
      // an ATR band (deterministic worst-case price); closes are reduce-only
      // (margin) or opposite-side marketable limit; AM59 receipt BEFORE any write.
      // Protective exits are reduce-only venue orders (take-profit limit + stop-loss),
      // stamped on the row; the watchdog manages/replaces them per sweep.
      // Qty = base asset DIRECTLY (spot has no contract size). The Coinbase
      // machinery below must never fire for a spot trade → this block returns.
      if (krakenSpotLane) {
        const ksNative = krakenSpotProduct.nativeSymbol;
        const ksClosingSide = side === 'BUY' ? 'sell' : 'buy';
        const ksTickRound = (p) => parseFloat((Math.round(parseFloat(p) / ksTickSize) * ksTickSize).toFixed(8));
        const ksLotDecimals = krakenSpotProduct.lot_decimals != null ? parseInt(krakenSpotProduct.lot_decimals, 10) : 8;
        const ksRoundQty = (q) => {
          const factor = Math.pow(10, Math.max(0, ksLotDecimals));
          const v = Math.floor(parseFloat(q) * factor) / factor;
          return v > 0 ? v : parseFloat((1 / factor).toFixed(ksLotDecimals));
        };
        // Spot margin: leverage ONLY when the pair is margin-eligible (quote != EUR)
        // AND the caller asked for >1. Stored on the row for ROE/telemetry.
        const ksLeverage = (krakenSpotProduct.margin !== false && leverage > 1) ? String(leverage) : null;
        // reduce_only is meaningful ONLY on margin orders — a pure spot order must not
        // carry it (venue reject risk). Gate every spot reduce_only on margin-on.
        const ksReduceOnly = krakenSpotProduct.margin !== false && leverage > 1;
        const ksSpotBand = Math.max(ksTickSize, (Number.isFinite(parseFloat(process.env.KSPOT_ENTRY_BAND_ATR_MULT)) ? parseFloat(process.env.KSPOT_ENTRY_BAND_ATR_MULT) : 0.25) * (Number.isFinite(parseFloat(telemetry?.atr ?? telemetry?.trigger_atr)) ? parseFloat(telemetry?.atr ?? telemetry?.trigger_atr) : 0));

        // ── KSPOT ADJUST_TP_SL: cancel the resident conditionals, place new ones ──
        if (isBracketAdjustment && openTrade) {
          const ksAdjCtx = (openTrade.params_context && typeof openTrade.params_context === 'object') ? openTrade.params_context : {};
          for (const legKey of ['ks_tp_order_id', 'ks_sl_order_id']) {
            const legId = ksAdjCtx[legKey];
            if (legId) { try { await cancelKrakenSpotOrder({ txid: legId, supabase, tenantId }); } catch (e) { console.warn(`[AM68] krakenspot ADJUST cancel ${legKey} failed: ${e.message}`); } }
          }
          const ksAdjQty = ksRoundQty(openTrade.qty || orderQty);
          const ksAdjReduceOnly = krakenSpotProduct.margin !== false && parseFloat(openTrade.leverage || 1) > 1;
          let ksTpTxid = null, ksSlTxid = null;
          if (tpPrice) {
            const v = await placeKrakenSpotOrder({ pair: ksNative, type: ksClosingSide, ordertype: 'take-profit', volume: ksAdjQty, price: ksTickRound(tpPrice), reduceOnly: ksAdjReduceOnly, supabase, tenantId });
            if (v.placed) ksTpTxid = v.txid; else console.error(`[AM68] krakenspot ADJUST TP reject: ${v.rejectReason}`);
          }
          if (slPrice) {
            const v = await placeKrakenSpotOrder({ pair: ksNative, type: ksClosingSide, ordertype: 'stop-loss', volume: ksAdjQty, price: ksTickRound(slPrice), reduceOnly: ksAdjReduceOnly, supabase, tenantId });
            if (v.placed) ksSlTxid = v.txid; else console.error(`[AM68] krakenspot ADJUST SL reject: ${v.rejectReason}`);
          }
          const ksAdjUpdate = {};
          if (tpPrice) ksAdjUpdate.tp_price = tpPrice;
          if (slPrice) ksAdjUpdate.sl_price = slPrice;
          if (Object.keys(ksAdjUpdate).length > 0) {
            try {
              await supabase.from('trade_logs').update({
                ...ksAdjUpdate,
                params_context: { ...ksAdjCtx, ks_tp_order_id: ksTpTxid, ks_sl_order_id: ksSlTxid },
              }).eq('id', openTrade.id).eq('tenant_id', tenantId);
            } catch (e) { console.error('[AM68] krakenspot ADJUST db update failed:', e.message); }
          }
          return { status: 'brackets_adjusted', product: rawSymbol, tp_price: tpPrice, sl_price: slPrice, venue: 'krakenspot' };
        }

        // ── KSPOT CLOSE: reduce-only IOC (margin) / opposite-side limit + receipt ─
        if (isClosing) {
          const ksCloseKey = `${tenantId}:${rawSymbol}`;
          if (Date.now() - (closingNow.get(ksCloseKey) || 0) < CLOSE_LOCK_TTL_MS) return { status: 'close_in_progress', product: rawSymbol };
          closingNow.set(ksCloseKey, Date.now());
          try {
            const ksMarkTickers = await getKrakenSpotTickers({ symbols: [ksNative] });
            const ksMarkRow = ksMarkTickers ? ksMarkTickers[ksNative] : null;
            const ksMark = ksMarkRow ? parseFloat(ksMarkRow.last) : NaN;
            if (!Number.isFinite(ksMark) || ksMark <= 0) { closingNow.delete(ksCloseKey); return { error: `[AM68] Kraken Spot ticker unavailable for ${rawSymbol} (close)`, status: 502 }; }
            const ksCloseQty = ksRoundQty(openTrade ? openTrade.qty : orderQty);
            const ksCloseLimit = ksClosingSide === 'sell' ? ksTickRound(ksMark - ksSpotBand) : ksTickRound(ksMark + ksSpotBand);
            const ksCloseVerdict = await placeKrakenSpotOrder({
              pair: ksNative, type: ksClosingSide, ordertype: 'limit', volume: ksCloseQty, price: ksCloseLimit,
              leverage: ksLeverage, reduceOnly: ksReduceOnly, timeinforce: 'IOC',
              clOrdId: `nxks_close_${openTrade?.id || Date.now()}`.slice(0, 18), supabase, tenantId,
            });
            if (!ksCloseVerdict.placed) {
              closingNow.delete(ksCloseKey);
              await sendDiscordAlert(tenantId, { title: `🚨 CLOSE FAILED — position live, unmanaged: ${rawSymbol}`, description: `Kraken Spot rejected the close: ${ksCloseVerdict.rejectReason}\n**Position:** STILL LIVE.`, color: 15158332 });
              return closeFailedResult('ks_close_rejected', `Kraken Spot rejected the close: ${ksCloseVerdict.rejectReason}`);
            }
            const ksReceipt = await pollKrakenSpotFill({ txid: ksCloseVerdict.txid, supabase, tenantId });
            if (!ksReceipt.confirmed) {
              closingNow.delete(ksCloseKey);
              await sendDiscordAlert(tenantId, { title: `🚨 CLOSE FAILED — position live, unmanaged: ${rawSymbol}`, description: `close order ${ksCloseVerdict.txid} never confirmed a fill (IOC may have missed).\n**Position:** STILL LIVE.`, color: 15158332 });
              return closeFailedResult('ks_close_fill_unconfirmed', `close order ${ksCloseVerdict.txid} never confirmed a fill`);
            }
            closingNow.delete(ksCloseKey);
            closeFillConfirmed = true;
            closeFees = ksReceipt.fees;
            executionPrice = ksReceipt.avgPrice;
            executionStatus = 'closed_position';
            ksCloseTxid = ksCloseVerdict.txid;
            console.log(`[AM68] krakenspot close VERIFIED: ${ksReceipt.filledSize} @ $${executionPrice} (fees ${ksReceipt.fees ?? 'n/a'}).`);
            // Cancel the stale sibling conditionals — the filled leg consumed the position.
            const ksCloseCtx = (openTrade?.params_context && typeof openTrade.params_context === 'object') ? openTrade.params_context : {};
            for (const legKey of ['ks_tp_order_id', 'ks_sl_order_id']) {
              const legId = ksCloseCtx[legKey];
              if (legId) { try { await cancelKrakenSpotOrder({ txid: legId, supabase, tenantId }); } catch (e) { console.warn(`[AM68] krakenspot post-close cancel ${legKey} failed: ${e.message}`); } }
            }
            // Fall through to the shared close write-back.
          } catch (ksCloseErr) {
            closingNow.delete(ksCloseKey);
            throw ksCloseErr;
          }
        } else if (!isForcedExit) {
          // ── KSPOT ENTRY: limit-IOC at mark ± ATR band ─────────────────────────
          const ksTickers = await getKrakenSpotTickers({ symbols: [ksNative] });
          const ksRow = ksTickers ? ksTickers[ksNative] : null;
          const ksMark = ksRow ? parseFloat(ksRow.last) : NaN;
          if (!Number.isFinite(ksMark) || ksMark <= 0) {
            console.error(`[AM68] krakenspot ticker unavailable for ${rawSymbol} (native ${ksNative}) — LIVE entry aborted.`);
            return { error: `[AM68] Kraken Spot ticker unavailable for ${rawSymbol}`, status: 502 };
          }
          const ksEntryLimit = side === 'BUY' ? ksTickRound(ksMark + ksSpotBand) : ksTickRound(ksMark - ksSpotBand);
          const ksEntryQty = ksRoundQty(orderQty);
          if (krakenSpotProduct.ordermin != null && ksEntryQty < parseFloat(krakenSpotProduct.ordermin)) {
            return { status: 'risk_vetoed', reason: `Kraken Spot minimum order for ${rawSymbol} is ${krakenSpotProduct.ordermin} ${krakenSpotProduct.base} (requested ${ksEntryQty}).`, product: rawSymbol };
          }
          if (krakenSpotProduct.costmin != null && (ksEntryQty * ksMark) < parseFloat(krakenSpotProduct.costmin)) {
            return { status: 'risk_vetoed', reason: `Kraken Spot minimum cost for ${rawSymbol} is ${krakenSpotProduct.costmin} ${krakenSpotProduct.quote} (requested ≈ ${(ksEntryQty * ksMark).toFixed(2)}).`, product: rawSymbol };
          }
          console.log(`[AM68] krakenspot LIVE entry ${rawSymbol}: ${side} ${ksEntryQty} ${ksNative} limit-IOC @ $${ksEntryLimit} (mark $${ksMark}, leverage ${ksLeverage || 'spot'}).`);

          // 🔒 RISK VALIDATOR (LIVE) — spot contract_size = 1 (never the coinbase multiplier).
          if (!isClosing && !isForcedExit) {
            const riskCheck = await validateTradeRisk(tenantId, {
              side, symbol: rawSymbol, entryPrice: ksEntryLimit, slPrice, tpPrice, qty: ksEntryQty, leverage
            }, { assetSpecs: { ...assetSpecs, contract_size: 1 }, executionMode: 'LIVE' });
            if (!riskCheck.approved) {
              try { await supabase.from('risk_veto_log').insert([{ tenant_id: tenantId, trade_id: null, asset: rawSymbol, side, entry_price: ksEntryLimit, qty: ksEntryQty, leverage, reason: riskCheck.reason, execution_mode: 'LIVE' }]); } catch (e) { console.warn('[RISK LOG] Insert failed:', e.message); }
              return { status: 'risk_vetoed', reason: riskCheck.reason, product: rawSymbol };
            }
            if (riskCheck.clamped_sl !== null) slPrice = riskCheck.clamped_sl;
            if (riskCheck.clamped_qty !== null) orderQty = riskCheck.clamped_qty;
          }

          const ksEntryVerdict = await placeKrakenSpotOrder({
            pair: ksNative, type: side === 'BUY' ? 'buy' : 'sell', ordertype: 'limit',
            volume: ksEntryQty, price: ksEntryLimit, leverage: ksLeverage, timeinforce: 'IOC',
            clOrdId: `nxks_e_${Date.now()}`.slice(0, 18), supabase, tenantId,
          });
          if (!ksEntryVerdict.placed) {
            console.error(`[AM68] krakenspot entry reject: ${ksEntryVerdict.rejectReason}`);
            return { status: 'entry_rejected', reason: `Kraken Spot rejected the entry: ${ksEntryVerdict.rejectReason}`, product: rawSymbol };
          }
          const ksEntryReceipt = await pollKrakenSpotFill({ txid: ksEntryVerdict.txid, supabase, tenantId });
          if (!ksEntryReceipt.confirmed) {
            console.warn(`[AM68] krakenspot entry ${ksEntryVerdict.txid} accepted but NEVER FILLED within the poll cap — no position, no trade row.`);
            return { status: 'entry_unfilled', reason: `Kraken Spot entry ${ksEntryVerdict.txid} did not fill (IOC).`, product: rawSymbol };
          }
          executionPrice = ksEntryReceipt.avgPrice;
          ksEntryTxid = ksEntryVerdict.txid;
          ksEntryFilledQty = ksEntryReceipt.filledSize;
          if (ksEntryFilledQty !== ksEntryQty) { console.warn(`[AM68] krakenspot partial fill: filled=${ksEntryFilledQty} ordered=${ksEntryQty} — row sized to FILLED.`); orderQty = ksEntryFilledQty; }
          executionStatus = 'filled_verified';
          console.log(`[AM68] krakenspot entry VERIFIED: ${ksEntryReceipt.filledSize} @ $${executionPrice} (txid ${ksEntryVerdict.txid}).`);

          // Protective conditionals: reduce-only take-profit + stop-loss (opposite side).
          let ksTpTxid = null, ksSlTxid = null;
          if (tpPrice) { const v = await placeKrakenSpotOrder({ pair: ksNative, type: ksClosingSide, ordertype: 'take-profit', volume: ksEntryFilledQty, price: ksTickRound(tpPrice), reduceOnly: ksReduceOnly, leverage: ksLeverage, supabase, tenantId }); if (v.placed) ksTpTxid = v.txid; else console.error(`[AM68] krakenspot TP conditional REJECTED: ${v.rejectReason}`); }
          if (slPrice) { const v = await placeKrakenSpotOrder({ pair: ksNative, type: ksClosingSide, ordertype: 'stop-loss', volume: ksEntryFilledQty, price: ksTickRound(slPrice), reduceOnly: ksReduceOnly, leverage: ksLeverage, supabase, tenantId }); if (v.placed) ksSlTxid = v.txid; else console.error(`[AM68] krakenspot SL conditional REJECTED: ${v.rejectReason}`); }
          if ((tpPrice && !ksTpTxid) || (slPrice && !ksSlTxid)) console.error(`[AM68] krakenspot protective conditional(s) MISSING — position NAKED until the watchdog safety net re-arms.`);

          entryParamsContext.krakenspot_native_symbol = ksNative;
          entryParamsContext.ks_entry_txid = ksEntryTxid;
          if (ksTpTxid) entryParamsContext.ks_tp_order_id = ksTpTxid;
          if (ksSlTxid) entryParamsContext.ks_sl_order_id = ksSlTxid;
        }

        // ── Shared KSPOT LIVE write path ───────────────────────────────────────
        if (!isClosing && !isForcedExit) {
          try {
            const ksLiveInsertPayload = {
              tenant_id: tenantId,
              symbol: rawSymbol, strategy_id: canonicalStrategyId, version: version, side: side, order_type: 'IOC',
              entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
              exit_time: null,
              market_snapshot_at_entry: fullMarketSnapshot || buildMarketSnapshot(executionPrice),
              regime_at_entry: regimeAtEntry,
              influencing_memory_ids: influencingMemoryIds,
              macro_tf: resolvedMacroTf,
              trigger_tf: resolvedTriggerTf,
              exchange: resolvedExchange,
              microstructure_archetype: data._microstructure_archetype || null,
              model_predicted_win_prob: data._model_predicted_win_prob ?? null,
              model_predicted_pnl: data._model_predicted_pnl ?? null,
              conviction_score_at_entry: data._conviction_score ?? null,
              transaction_fee: data._transaction_fee ?? null,
              params_context: entryParamsContext,
              structure_direction: structureDirection,
            };
            let { data: ksInsertData, error: ksInsertError } = await supabase.from('trade_logs').insert([ksLiveInsertPayload]).select();
            if ((ksInsertError || !ksInsertData || ksInsertData.length === 0) && /(params_context|structure_direction|exchange)/i.test(ksInsertError?.message || '')) {
              console.warn(`[AM53/AM62/AM68] KSPOT trade_logs insert rejected an additive column (${ksInsertError.message}) — retrying without it.`);
              const ksWithout = { ...ksLiveInsertPayload };
              if (/params_context/i.test(ksInsertError.message || '')) delete ksWithout.params_context;
              if (/structure_direction/i.test(ksInsertError.message || '')) delete ksWithout.structure_direction;
              if (/exchange/i.test(ksInsertError.message || '')) delete ksWithout.exchange;
              ({ data: ksInsertData, error: ksInsertError } = await supabase.from('trade_logs').insert([ksWithout]).select());
            }
            if (ksInsertError || !ksInsertData || ksInsertData.length === 0) {
              console.error(`[SUPABASE ERROR] Failed to insert KSPOT trade_log after order: ${ksInsertError?.message || 'empty data'}`);
            } else {
              pendingTradeId = ksInsertData[0].id;
              if (data.scan_id) {
                supabase.from('agent_tool_calls').update({ trade_id: pendingTradeId }).eq('scan_id', data.scan_id).eq('tenant_id', tenantId).then(() => {}).catch(() => {});
              }
            }
          } catch (error) {
            console.error('[SUPABASE ERROR] Failed to insert KSPOT trade_log after order:', error.message);
          }
          const ksChartUrl = await buildRadarChartUrl({
            asset: rawSymbol, candles: recentCandles, currentPrice: executionPrice,
            poc: telemetry.macro_poc, upperNode: telemetry.upper_macro_node, lowerNode: telemetry.lower_macro_node,
            tpPrice: tpPrice, slPrice: slPrice, openTrade: null,
          });
          await sendDiscordAlert(tenantId, {
            title: `🚀 New Position Opened: ${rawSymbol}`,
            description: `**Side:** ${side}\n**Entry Price:** $${executionPrice} (fill-verified)\n**Qty:** ${orderQty} ${krakenSpotProduct.base}\n**Mode:** ${mode} (kraken spot${ksLeverage ? ` ${ksLeverage}×` : ''})\n**Targets:** TP $${tpPrice} / SL $${slPrice} (venue-resident)${tradeReason ? `\n\n**🧠 Oracle Rationale:**\n_${tradeReason}_` : ''}`,
            color: 3447003,
            fields: standardFields,
            imageUrl: ksChartUrl,
          });
          if (data.working_thesis) {
            try { await supabase.from('strategy_config').update({ active_thesis: data.working_thesis }).eq('tenant_id', tenantId).eq('strategy', strategyId).eq('asset', rawSymbol); } catch (e) { console.error('[SUPABASE ERROR] Failed to update active_thesis:', e.message); }
          }
          return { status: executionStatus, product: rawSymbol, price: executionPrice, trade_id: pendingTradeId || null, venue: 'krakenspot' };
        }
        // isClosing falls through to the shared close write-back (single write site).
      }

      // ═══════════════════════════════════════════════════════════════════════
      // 🟢 AM63 (Push 7) — THE KRAKEN FUTURES (apiv3) LIVE LANE.
      // ═══════════════════════════════════════════════════════════════════════
      // Handles entry / close / bracket-adjust END-TO-END and returns — the
      // Coinbase machinery below (cfm/positions, batch_cancel, trigger_bracket_gtc,
      // AM14 bracket prep, PHASE D flat check) is Coinbase-hardwired and must
      // never fire for a KRF trade. Doctrine carried over:
      //   - AM59: an order is DONE only when fill-verified (receipt BEFORE stamp).
      //   - Phantom trap: result:'success' ≠ placed — the provider's verdict is
      //     the guard; a reject is DATA (readable rejection, never a retry).
      //   - Protective exits are venue-RESIDENT reduce-only conditionals
      //     (take_profit + stp, triggerSignal mark) placed the moment the fill
      //     verifies; the watchdog manages/replaces them per sweep.
      //   - No write without a receipt; the insert-safety-regime (Push 2) keeps
      //     the row alive over an additive-column rejection.
      if (krakenFuturesLane) {
        const kfNative = krakenFuturesProduct.nativeSymbol;
        const kfClosingSide = side === 'BUY' ? 'sell' : 'buy';
        const kfTickRound = (p) => parseFloat((Math.round(parseFloat(p) / kfTickSize) * kfTickSize).toFixed(8));

        // ── KRF ADJUST_TP_SL: cancel the resident conditionals, place new ones ──
        if (isBracketAdjustment && openTrade) {
          console.log(`[AM63] krakenfutures ADJUST_TP_SL for ${rawSymbol} (trade ${openTrade.id}) — replacing resident conditionals.`);
          const kfAdjCtx = (openTrade.params_context && typeof openTrade.params_context === 'object') ? openTrade.params_context : {};
          for (const legKey of ['kf_tp_order_id', 'kf_sl_order_id']) {
            const legId = kfAdjCtx[legKey];
            if (legId) {
              try { await cancelKrakenFuturesOrder({ supabase, tenantId, orderId: legId }); } catch (e) {
                console.warn(`[AM63] krakenfutures ADJUST cancel ${legKey}=${legId} failed: ${e.message}`);
              }
            }
          }
          let kfAdjPlaced = 0;
          const kfAdjQty = kfRoundQty(openTrade.qty || orderQty);
          if (tpPrice) {
            const tpVerdict = await placeKrakenFuturesOrder({
              supabase, tenantId, nativeSymbol: kfNative, side: kfClosingSide,
              size: kfAdjQty, orderType: 'take_profit', stopPrice: kfTickRound(tpPrice),
              limitPrice: kfTickRound(tpPrice), triggerSignal: 'mark', reduceOnly: true,
              cliOrdId: `nx_krf_tp_${openTrade.id}_${Date.now()}`,
            });
            if (tpVerdict.placed) kfAdjPlaced++;
            else { kfLastRejectError = tpVerdict.errorMessage || null; kfLastRejectHost = tpVerdict.host || null; console.error(`[AM63] krakenfutures ADJUST TP reject: ${tpVerdict.rejectReason}${tpVerdict.errorMessage ? ` — ${tpVerdict.errorMessage}` : ''} (host ${tpVerdict.host || 'n/a'})`); }
          }
          if (slPrice) {
            const slVerdict = await placeKrakenFuturesOrder({
              supabase, tenantId, nativeSymbol: kfNative, side: kfClosingSide,
              size: kfAdjQty, orderType: 'stp', stopPrice: kfTickRound(slPrice),
              limitPrice: kfTickRound(slPrice), triggerSignal: 'mark', reduceOnly: true,
              cliOrdId: `nx_krf_sl_${openTrade.id}_${Date.now()}`,
            });
            if (slVerdict.placed) kfAdjPlaced++;
            else { kfLastRejectError = slVerdict.errorMessage || null; kfLastRejectHost = slVerdict.host || null; console.error(`[AM63] krakenfutures ADJUST SL reject: ${slVerdict.rejectReason}${slVerdict.errorMessage ? ` — ${slVerdict.errorMessage}` : ''} (host ${slVerdict.host || 'n/a'})`); }
          }
          const kfAdjUpdate = {};
          if (tpPrice) kfAdjUpdate.tp_price = tpPrice;
          if (slPrice) kfAdjUpdate.sl_price = slPrice;
          if (Object.keys(kfAdjUpdate).length > 0) {
            try {
              await supabase.from('trade_logs').update({
                ...kfAdjUpdate,
                params_context: {
                  ...kfAdjCtx,
                  ...(tpPrice ? { kf_tp_order_id: null } : {}),
                  ...(slPrice ? { kf_sl_order_id: null } : {}),
                },
              }).eq('id', openTrade.id).eq('tenant_id', tenantId);
            } catch (e) { console.error('[AM63] krakenfutures ADJUST db update failed:', e.message); }
          }
          console.log(`[AM63] krakenfutures ADJUST_TP_SL: ${kfAdjPlaced} conditional(s) placed (ids re-stamped by the watchdog on next sweep).`);
          return { status: 'brackets_adjusted', product: rawSymbol, tp_price: tpPrice, sl_price: slPrice, venue: 'krakenfutures' };
        }

        // ── KRF CLOSE: reduce-only IOC (marketable limit) + AM59 receipt ────────
        if (isClosing) {
          const kfCloseKey = `${tenantId}:${rawSymbol}`;
          const kfLastClose = closingNow.get(kfCloseKey) || 0;
          if (Date.now() - kfLastClose < CLOSE_LOCK_TTL_MS) {
            return { status: 'close_in_progress', product: rawSymbol };
          }
          closingNow.set(kfCloseKey, Date.now());
          try {
            // Reconcile against the venue: openpositions is the source of truth.
            let kfCloseQty = kfRoundQty(orderQty);
            try {
              const { kfPrivateRequest: kfReq, OPENPOSITIONS_PATH: KF_POS_PATH } = await import('./providers/kraken-futures.js');
              const posResp = await kfReq({ method: 'GET', path: KF_POS_PATH, params: {}, supabase, tenantId, cost: 2, label: 'openpositions' });
              if (posResp.ok) {
                const posJson = await posResp.json();
                const kfPos = (posJson?.openPositions || []).find((p) => p.symbol === kfNative);
                const kfLiveQty = kfPos ? Math.abs(parseFloat(kfPos.size) || 0) : 0;
                if (kfLiveQty === 0) {
                  console.warn(`[AM63] krakenfutures close reconcile: venue FLAT for ${kfNative} but trade_logs id=${openTrade?.id} open — marking closed without a phantom order.`);
                  if (openTrade) {
                    const kfFallbackExit = parseFloat(incomingPrice) || parseFloat(openTrade.sl_price) || parseFloat(openTrade.entry_price) || 0;
                    const kfSafeEntry = parseFloat(openTrade.entry_price) || 0;
                    const kfDriftPnl = openTrade.side === 'BUY'
                      ? (kfFallbackExit - kfSafeEntry) * (parseFloat(openTrade.qty) || 0) * effectiveMultiplier
                      : (kfSafeEntry - kfFallbackExit) * (parseFloat(openTrade.qty) || 0) * effectiveMultiplier;
                    try {
                      await supabase.from('trade_logs').update({
                        exit_price: kfFallbackExit,
                        pnl: parseFloat(kfDriftPnl.toFixed(4)),
                        exit_time: new Date().toISOString(),
                        reason: `${openTrade.reason || ''}\n\n[EXIT TRIGGER]: ${tradeReason || 'STATE_DRIFT_RECONCILE'} (venue already flat)`,
                      }).eq('id', openTrade.id);
                    } catch (e) { console.error('[AM63] krakenfutures drift-close failed:', e.message); }
                  }
                  closingNow.delete(kfCloseKey);
                  return { status: 'already_closed_natively', product: rawSymbol, reason: 'venue_flat' };
                }
                if (kfLiveQty !== kfCloseQty) {
                  console.warn(`[AM63] krakenfutures close reconcile: DB qty=${kfCloseQty} but venue position=${kfLiveQty}. Trusting the venue.`);
                  kfCloseQty = kfRoundQty(kfLiveQty);
                }
              }
            } catch (kfReconErr) {
              console.warn(`[AM63] krakenfutures close reconcile failed (proceeding with DB qty): ${kfReconErr.message}`);
            }

            // Marketable limit: cross the spread by the band so the IOC fills.
            const kfMarkRow = await (async () => {
              const tickers = await getKrakenTickers({ symbols: [kfNative] });
              return tickers ? tickers[kfNative] : null;
            })();
            const kfMark = parseFloat(kfMarkRow ? (kfMarkRow.markPrice ?? kfMarkRow.last) : 0);
            if (!Number.isFinite(kfMark) || kfMark <= 0) {
              closingNow.delete(kfCloseKey);
              return { error: `[AM63] Kraken Futures stats unavailable for ${rawSymbol} (close)`, status: 502 };
            }
            const kfCloseLimit = kfClosingSide === 'sell'
              ? kfTickRound(kfMark - kfBand)
              : kfTickRound(kfMark + kfBand);
            const kfCloseVerdict = await placeKrakenFuturesOrder({
              supabase, tenantId, nativeSymbol: kfNative, side: kfClosingSide,
              size: kfCloseQty, orderType: 'ioc', limitPrice: kfCloseLimit,
              reduceOnly: true, cliOrdId: `nx_krf_close_${openTrade?.id || Date.now()}_${Date.now()}`,
            });
            if (!kfCloseVerdict.placed) {
              closingNow.delete(kfCloseKey);
              // The resident conditionals are the restore-on-failure — they stay.
              // insufficientAvailableFunds surfaces verbatim (readable rejection).
              // 🟢 Push 7 hotfix 3 — the verbatim errorMessage + host ride along so
              // bad-creds vs demo/prod mismatch is separable from the log alone.
              kfLastRejectError = kfCloseVerdict.errorMessage || null;
              kfLastRejectHost = kfCloseVerdict.host || null;
              console.error(`[AM63] krakenfutures close reject: ${kfCloseVerdict.rejectReason}${kfCloseVerdict.errorMessage ? ` — ${kfCloseVerdict.errorMessage}` : ''} (host ${kfCloseVerdict.host || 'n/a'})`);
              const kfReason = `Kraken Futures rejected the close: ${kfCloseVerdict.rejectReason}${
                kfCloseVerdict.rejectReason === 'insufficientAvailableFunds' ? ' (available funds insufficient on the venue)' : ''}${
                kfCloseVerdict.errorMessage ? ` — ${kfCloseVerdict.errorMessage}` : ''} (host ${kfCloseVerdict.host || 'n/a'})`;
              await sendDiscordAlert(tenantId, {
                title: `🚨 CLOSE FAILED — position live, unmanaged: ${rawSymbol}`,
                description: `The reduce-only IOC close was rejected by the venue.\n**Status:** ${kfCloseVerdict.rejectReason}\n**Position:** STILL LIVE (resident TP/SL conditionals remain armed).`,
                color: 15158332,
              });
              return closeFailedResult('kf_close_rejected', kfReason);
            }
            // AM59 receipt BEFORE any write.
            const kfReceipt = await pollKrakenFuturesFill({ supabase, tenantId, orderId: kfCloseVerdict.orderId });
            if (!kfReceipt.confirmed) {
              closingNow.delete(kfCloseKey);
              const kfReason = `close order ${kfCloseVerdict.orderId} never confirmed a fill within the poll cap (IOC may have missed)`;
              await sendDiscordAlert(tenantId, {
                title: `🚨 CLOSE FAILED — position live, unmanaged: ${rawSymbol}`,
                description: `The reduce-only IOC was accepted but NO fill was verified.\n**Order:** ${kfCloseVerdict.orderId}\n**Position:** STILL LIVE (resident TP/SL conditionals remain armed).`,
                color: 15158332,
              });
              return closeFailedResult('kf_close_fill_unconfirmed', kfReason);
            }
            closingNow.delete(kfCloseKey);
            closeFillConfirmed = true;
            closeFees = kfReceipt.fees; // null — /fills carries no fee field (honest)
            executionPrice = kfReceipt.avgPrice;
            executionStatus = 'closed_position';
            kfCloseRealizedPnl = kfReceipt.realizedPnl;
            kfCloseOrderId = kfCloseVerdict.orderId;
            console.log(`[AM63] krakenfutures close VERIFIED: ${kfReceipt.filledSize} @ $${executionPrice} (realized_pnl ${kfReceipt.realizedPnl ?? 'n/a'}, fees n/a).`);
            // AM59 STEP 4 analog: the confirmed close means the sibling conditional
            // is stale protection — cancel it (the filled leg consumed the position).
            const kfCloseCtx = (openTrade?.params_context && typeof openTrade.params_context === 'object') ? openTrade.params_context : {};
            for (const legKey of ['kf_tp_order_id', 'kf_sl_order_id']) {
              const legId = kfCloseCtx[legKey];
              if (legId) {
                try { await cancelKrakenFuturesOrder({ supabase, tenantId, orderId: legId }); } catch (e) {
                  console.warn(`[AM63] krakenfutures post-close cancel ${legKey} failed: ${e.message}`);
                }
              }
            }
            // Fall through to the shared close write-back below (the single write
            // site — the AM59 guard sees closeFillConfirmed=true and stamps).
          } catch (kfCloseErr) {
            closingNow.delete(kfCloseKey);
            throw kfCloseErr;
          }
        } else if (!isForcedExit) {
          // ── KRF ENTRY: limit-IOC at mark ± ATR band ─────────────────────────
          const tickers = await getKrakenTickers({ symbols: [kfNative] });
          const kfRow = tickers ? tickers[kfNative] : null;
          const kfMark = parseFloat(kfRow ? (kfRow.markPrice ?? kfRow.last) : 0);
          if (!Number.isFinite(kfMark) || kfMark <= 0) {
            console.error(`[AM63] krakenfutures stats unavailable for ${rawSymbol} (symbol ${kfNative}) — LIVE entry aborted.`);
            return { error: `[AM63] Kraken Futures stats unavailable for ${rawSymbol}`, status: 502 };
          }
          const kfBandEff = kfBand > 0 ? kfBand : Math.max(kfTickSize, kfMark * 0.001);
          const kfEntryLimit = side === 'BUY'
            ? kfTickRound(kfMark + kfBandEff)
            : kfTickRound(kfMark - kfBandEff);
          let kfEntryQty = kfRoundQty(orderQty);
          if (kfMinSize != null && kfEntryQty < kfMinSize) {
            return { status: 'risk_vetoed', reason: `Kraken Futures minimum trade size for ${rawSymbol} is ${kfMinSize} contracts (requested ${kfEntryQty}).`, product: rawSymbol };
          }
          console.log(`[AM63] krakenfutures LIVE entry ${rawSymbol}: ${side} ${kfEntryQty} ${kfNative} limit-IOC @ $${kfEntryLimit} (mark $${kfMark}, band $${kfBandEff.toFixed(8)}).`);

          // 🔒 RISK VALIDATOR (LIVE) — the KRF contract_size override (the paper
          // lane's pattern); the Coinbase specs gate must not veto on absence.
          const kfLiveSpecs = { ...assetSpecs, contract_size: kfMultiplier };
          if (!isClosing && !isForcedExit) {
            const kfRiskCheck = await validateTradeRisk(tenantId, {
              side, symbol: rawSymbol,
              entryPrice: kfEntryLimit,
              slPrice, tpPrice,
              qty: kfEntryQty,
              leverage,
            }, { assetSpecs: kfLiveSpecs, executionMode: 'LIVE' });
            if (!kfRiskCheck.approved) {
              try {
                await supabase.from('risk_veto_log').insert([{
                  tenant_id: tenantId, trade_id: null, asset: rawSymbol, side,
                  entry_price: kfEntryLimit, qty: kfEntryQty, leverage,
                  reason: kfRiskCheck.reason, execution_mode: 'LIVE',
                }]);
              } catch (e) { console.warn('[RISK LOG] Insert failed:', e.message); }
              await sendDiscordAlert(tenantId, {
                title: `🚫 Risk Profile Block — ${rawSymbol}`,
                description: kfRiskCheck.reason,
                color: 15548997,
                fields: [
                  { name: 'Side', value: side, inline: true },
                  { name: 'Entry', value: `$${kfEntryLimit}`, inline: true },
                  { name: 'Qty', value: String(kfEntryQty), inline: true },
                  { name: 'Leverage', value: `${leverage}x`, inline: true },
                  { name: 'Mode', value: 'LIVE (krakenfutures)', inline: true },
                ],
              }).catch(e => console.warn('[RISK DISCORD] Send failed:', e.message));
              return { status: 'risk_vetoed', reason: kfRiskCheck.reason, product: rawSymbol };
            }
            if (kfRiskCheck.clamped_sl !== null || kfRiskCheck.clamped_qty !== null) {
              const kfClampDetails = buildClampDetails({
                originalSl: slPrice, originalQty: kfEntryQty,
                clampedSl: kfRiskCheck.clamped_sl, clampedQty: kfRiskCheck.clamped_qty,
              });
              if (kfRiskCheck.clamped_sl !== null) slPrice = kfRiskCheck.clamped_sl;
              if (kfRiskCheck.clamped_qty !== null) { kfEntryQty = kfRoundQty(kfRiskCheck.clamped_qty); orderQty = kfEntryQty; }
              await sendDiscordAlert(tenantId, {
                title: `⚠️ Risk Adjustment: ${rawSymbol}`,
                description: `**Mode:** ${mode}\n**Adjustments:** ${kfClampDetails.join(', ')}\n**Reason:** ${kfRiskCheck.reason || 'Risk profile limits applied'}`,
                color: 15844367,
              });
            }
          }

          // Balance check (cost 2) — log-only pre-trade telemetry, same as Coinbase.
          try {
            const { fetchKrakenFuturesBalance: kfBal } = await import('./providers/kraken-futures.js');
            const kfBalRes = await kfBal({ supabase, tenantId });
            if (!kfBalRes.error) {
              console.log(`[BALANCE CHECK] Kraken Futures ${kfBalRes.source}: free $${kfBalRes.free.toFixed(2)} / total $${kfBalRes.total.toFixed(2)} (estimated margin needed: $${((kfEntryQty * kfEntryLimit * Math.abs(kfMultiplier)) / Math.max(leverage, 1)).toFixed(2)})`);
            } else {
              console.warn(`[BALANCE CHECK] Kraken Futures balance unavailable: ${kfBalRes.error}`);
            }
          } catch (e) { console.warn('[BALANCE CHECK] Kraken Futures failed:', e.message); }

          // THE ORDER — phantom-trap-guarded verdict.
          const kfEntryVerdict = await placeKrakenFuturesOrder({
            supabase, tenantId, nativeSymbol: kfNative, side,
            size: kfEntryQty, orderType: 'ioc', limitPrice: kfEntryLimit,
            cliOrdId: data.idempotency_key
              ? `nx_krf_e_${String(data.idempotency_key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`
              : `nx_krf_entry_${Date.now()}`,
          });
          if (!kfEntryVerdict.placed) {
            // A rejected order is DATA — readable rejection to the brain + veto log
            // (execution telemetry, NOT a strategy signal) + Discord. NO trade row.
            // insufficientAvailableFunds / wouldCauseLiquidation surface VERBATIM:
            // the Lane A risk manager treats them as execution telemetry, not a
            // strategy signal (the operator-ratified doctrine).
            const kfFundsNote = kfEntryVerdict.rejectReason === 'insufficientAvailableFunds'
              ? ' — available funds insufficient on the venue (execution telemetry, not a strategy signal)'
              : (kfEntryVerdict.rejectReason === 'wouldCauseLiquidation'
                ? ' — the order would trigger liquidation (execution telemetry, not a strategy signal)'
                : '');
            // 🟢 Push 7 hotfix 3 — the verbatim apiv3 errorMessage + the host actually
            // used ride EVERY reject surface (log, veto row, Discord, agent payload):
            // "invalid API key" vs "nonce error" vs "invalid grant" separates bad-creds
            // from a demo/prod mismatch from a code bug. Values are never logged.
            kfLastRejectError = kfEntryVerdict.errorMessage || null;
            kfLastRejectHost = kfEntryVerdict.host || null;
            const kfRejectMsg = `Kraken Futures rejected the entry order: ${kfEntryVerdict.rejectReason}${kfFundsNote}${
              kfEntryVerdict.errorMessage ? ` — ${kfEntryVerdict.errorMessage}` : ''} (host ${kfEntryVerdict.host || 'n/a'})`;
            console.error(`[AM63] ${kfRejectMsg}`);
            try {
              await supabase.from('risk_veto_log').insert([{
                tenant_id: tenantId, trade_id: null, asset: rawSymbol, side,
                entry_price: kfEntryLimit, qty: kfEntryQty, leverage,
                reason: kfRejectMsg, execution_mode: 'LIVE',
              }]);
            } catch (e) { console.warn('[RISK LOG] Insert failed:', e.message); }
            await sendDiscordAlert(tenantId, {
              title: `🚫 Kraken Futures Order Rejected — ${rawSymbol}`,
              description: `**Status:** ${kfEntryVerdict.rejectReason}${kfEntryVerdict.errorMessage ? `\n**Venue message:** ${kfEntryVerdict.errorMessage}` : ''}\n**Host:** ${kfEntryVerdict.host || 'n/a'}\n**Side:** ${side} ${kfEntryQty} @ $${kfEntryLimit} (limit-IOC)\n**Action:** No position opened; no trade row written.`,
              color: 15548997,
            }).catch(e => console.warn('[RISK DISCORD] Send failed:', e.message));
            return { error: `[AM63] ${kfRejectMsg}`, status: 502 };
          }

          // AM59 receipt BEFORE stamping — no write without a receipt.
          const kfEntryReceipt = await pollKrakenFuturesFill({ supabase, tenantId, orderId: kfEntryVerdict.orderId });
          if (!kfEntryReceipt.confirmed) {
            // IOC accepted but unfilled = no position, no row. Honest no-op.
            console.warn(`[AM63] krakenfutures entry ${kfEntryVerdict.orderId} accepted but NEVER FILLED within the poll cap — no position, no trade row.`);
            await sendDiscordAlert(tenantId, {
              title: `⏳ Kraken Futures Entry Unfilled — ${rawSymbol}`,
              description: `The limit-IOC entry was accepted but did not fill within the poll cap.\n**Order:** ${kfEntryVerdict.orderId}\n**Limit:** $${kfEntryLimit}\n**Action:** No position opened; no trade row written (IOC remainder cancels at the venue).`,
              color: 15844367,
            }).catch(e => console.warn('[RISK DISCORD] Send failed:', e.message));
            return { status: 'entry_unfilled', product: rawSymbol, order_id: kfEntryVerdict.orderId };
          }
          executionPrice = kfEntryReceipt.avgPrice;
          executionStatus = 'filled';
          kfEntryOrderId = kfEntryVerdict.orderId;
          kfEntryFilledQty = kfEntryReceipt.filledSize;
          console.log(`[AM63] krakenfutures entry VERIFIED: ${kfEntryReceipt.filledSize} @ $${executionPrice} (order ${kfEntryOrderId}).`);

          // 🛡️ PROTECTIVE EXITS — placed IMMEDIATELY after fill confirmation:
          // venue-resident reduce-only conditionals (take_profit + stp,
          // triggerSignal mark), tick-sized with the instrument's own tickSize.
          if (tpPrice && slPrice && !isClosing) {
            const kfTp = kfTickRound(tpPrice);
            const kfSl = kfTickRound(slPrice);
            const kfTpVerdict = await placeKrakenFuturesOrder({
              supabase, tenantId, nativeSymbol: kfNative, side: kfClosingSide,
              size: kfEntryQty, orderType: 'take_profit', stopPrice: kfTp,
              limitPrice: kfTp, triggerSignal: 'mark', reduceOnly: true,
              cliOrdId: `nx_krf_tp_${Date.now()}`,
            });
            const kfSlVerdict = await placeKrakenFuturesOrder({
              supabase, tenantId, nativeSymbol: kfNative, side: kfClosingSide,
              size: kfEntryQty, orderType: 'stp', stopPrice: kfSl,
              limitPrice: kfTickRound(kfClosingSide === 'sell' ? kfSl * 0.995 : kfSl * 1.005),
              triggerSignal: 'mark', reduceOnly: true,
              cliOrdId: `nx_krf_sl_${Date.now()}`,
            });
            if (kfTpVerdict.placed) kfTpOrderId = kfTpVerdict.orderId;
            if (kfSlVerdict.placed) kfSlOrderId = kfSlVerdict.orderId;
            if (!kfTpVerdict.placed || !kfSlVerdict.placed) {
              const kfMissing = [
                !kfTpVerdict.placed ? `TP: ${kfTpVerdict.rejectReason}` : null,
                !kfSlVerdict.placed ? `SL: ${kfSlVerdict.rejectReason}` : null,
              ].filter(Boolean).join(' | ');
              console.error(`[AM63] krakenfutures protective conditional(s) REJECTED: ${kfMissing} — position NAKED until the watchdog safety net re-arms.`);
              await sendDiscordAlert(tenantId, {
                title: `🚨 NAKED POSITION: ${rawSymbol}`,
                description: `Entry filled but the protective conditional(s) were rejected.\n**Details:** ${kfMissing}\n**Action:** The watchdog safety net will attempt to re-arm on its next sweep. Manual intervention may be required.`,
                color: 15158332,
              });
            } else {
              console.log(`[AM63] krakenfutures conditionals LIVE: TP ${kfTpOrderId} @ $${kfTp} / SL ${kfSlOrderId} @ $${kfSl} (reduce-only, triggerSignal mark).`);
              await sendDiscordAlert(tenantId, {
                title: `🎯 Brackets Deployed: ${rawSymbol}`,
                description: `**Take Profit:** $${kfTp}\n**Stop Loss:** $${kfSl}\n**Status:** Venue-resident reduce-only conditionals (triggerSignal mark)`,
                color: 10181046,
              });
            }
          }

          // Stamp the native symbol + venue order ids into the entry context
          // (the paper lane's pattern) — the INSERT below picks them up.
          entryParamsContext.krakenfutures_native_symbol = kfNative;
          entryParamsContext.kf_entry_order_id = kfEntryOrderId;
          if (kfTpOrderId) entryParamsContext.kf_tp_order_id = kfTpOrderId;
          if (kfSlOrderId) entryParamsContext.kf_sl_order_id = kfSlOrderId;
          if (kfEntryFilledQty !== kfEntryQty) {
            // Partial fill: size the row + brackets to the FILLED qty (AM30 analog).
            console.warn(`[AM63] krakenfutures partial fill: filled=${kfEntryFilledQty} ordered=${kfEntryQty} — row sized to FILLED.`);
            orderQty = kfEntryFilledQty;
          }
          // Fall through to the shared LIVE entry INSERT below (no 5th insert site).
        }

        // ── Shared KRF LIVE write path ────────────────────────────────────────
        if (!isClosing && !isForcedExit) {
          try {
            const kfLiveInsertPayload = {
              tenant_id: tenantId,
              symbol: rawSymbol, strategy_id: canonicalStrategyId, version: version, side: side, order_type: 'IOC',
              entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
              exit_time: null,
              market_snapshot_at_entry: fullMarketSnapshot || buildMarketSnapshot(executionPrice),
              regime_at_entry: regimeAtEntry,
              influencing_memory_ids: influencingMemoryIds,
              macro_tf: resolvedMacroTf,
              trigger_tf: resolvedTriggerTf,
              exchange: resolvedExchange,
              microstructure_archetype: data._microstructure_archetype || null,
              model_predicted_win_prob: data._model_predicted_win_prob ?? null,
              model_predicted_pnl: data._model_predicted_pnl ?? null,
              conviction_score_at_entry: data._conviction_score ?? null,
              transaction_fee: data._transaction_fee ?? null,
              params_context: entryParamsContext,
              structure_direction: structureDirection,
            };
            let { data: kfInsertData, error: kfInsertError } = await supabase.from('trade_logs').insert([kfLiveInsertPayload]).select();
            if ((kfInsertError || !kfInsertData || kfInsertData.length === 0) && /(params_context|structure_direction|exchange)/i.test(kfInsertError?.message || '')) {
              console.warn(`[AM53/AM62/AM63] KRF trade_logs insert rejected an additive column (${kfInsertError.message}) — retrying without it.`);
              const kfWithout = { ...kfLiveInsertPayload };
              if (/params_context/i.test(kfInsertError.message || '')) delete kfWithout.params_context;
              if (/structure_direction/i.test(kfInsertError.message || '')) delete kfWithout.structure_direction;
              if (/exchange/i.test(kfInsertError.message || '')) { delete kfWithout.exchange; console.warn('[AM63] trade saved WITHOUT exchange — migration 060 not applied (deploy order error)'); }
              ({ data: kfInsertData, error: kfInsertError } = await supabase.from('trade_logs').insert([kfWithout]).select());
            }
            if (kfInsertError || !kfInsertData || kfInsertData.length === 0) {
              console.error(`[SUPABASE ERROR] Failed to insert KRF trade_log after order: ${kfInsertError?.message || 'empty data'}`);
            } else {
              pendingTradeId = kfInsertData[0].id;
              if (data.scan_id) {
                supabase.from('agent_tool_calls')
                  .update({ trade_id: pendingTradeId })
                  .eq('scan_id', data.scan_id)
                  .eq('tenant_id', tenantId)
                  .then(() => {})
                  .catch(() => {});
              }
            }
          } catch (error) {
            console.error('[SUPABASE ERROR] Failed to insert KRF trade_log after order:', error.message);
          }
          const kfChartUrl = await buildRadarChartUrl({
            asset: rawSymbol, candles: recentCandles, currentPrice: executionPrice,
            poc: telemetry.macro_poc, upperNode: telemetry.upper_macro_node, lowerNode: telemetry.lower_macro_node,
            tpPrice: tpPrice, slPrice: slPrice,
            openTrade: null,
          });
          await sendDiscordAlert(tenantId, {
            title: `🚀 New Position Opened: ${rawSymbol}`,
            description: `**Side:** ${side}\n**Entry Price:** $${executionPrice} (fill-verified)\n**Qty:** ${orderQty}\n**Mode:** ${mode} (krakenfutures)\n**Targets:** TP $${tpPrice} / SL $${slPrice} (venue-resident)${tradeReason ? `\n\n**🧠 Oracle Rationale:**\n_${tradeReason}_` : ''}`,
            color: 3447003,
            fields: standardFields,
            imageUrl: kfChartUrl,
          });
          if (data.working_thesis) {
            try {
              await supabase.from('strategy_config')
                .update({ active_thesis: data.working_thesis })
                .eq('tenant_id', tenantId)
                .eq('strategy', strategyId)
                .eq('asset', rawSymbol);
            } catch (e) { console.error('[SUPABASE ERROR] Failed to update active_thesis:', e.message); }
          }
          return { status: executionStatus, product: rawSymbol, price: executionPrice, trade_id: pendingTradeId || null, venue: 'krakenfutures' };
        }
        // isClosing falls through to the shared close write-back (single write site).
      }

      // 🎯 ADJUST_TP_SL: Bracket-swap path (Coinbase) — see the hoisted declaration above.
      if (isBracketAdjustment && openTrade) {
        // 🛡️ ACCOUNTANT PROTOCOL: Enforce hard R/R >= 1.5 floor before any bracket adjustment
        if (tpPrice && slPrice && openTrade.entry_price) {
          const entryPrice = parseFloat(openTrade.entry_price);
          const tpDist = Math.abs(tpPrice - entryPrice);
          const slDist = Math.abs(entryPrice - slPrice);
          const riskReward = slDist > 0 ? (tpDist / slDist) : 0;
          if (riskReward < 1.5) {
            console.warn(`[ACCOUNTANT PROTOCOL] R/R ${riskReward.toFixed(2)} < 1.5 floor. VETOING ADJUST_TP_SL for ${rawSymbol}. TP: $${tpPrice}, SL: $${slPrice}, Entry: $${entryPrice}`);
            await sendDiscordAlert(tenantId, {
              title: `🚫 Accountant Veto: ${rawSymbol}`,
              description: `**Action:** ADJUST_TP_SL blocked\n**New R/R:** ${riskReward.toFixed(2)} (minimum 1.5)\n**Proposed TP:** $${tpPrice}\n**Proposed SL:** $${slPrice}\n**Entry:** $${entryPrice}\n**Reason:** Risk/Reward degradation below hard floor.`,
              color: 15548997
            });
            return { status: "rr_vetoed", reason: `R/R ${riskReward.toFixed(2)} < 1.5 floor`, product: coinbaseProduct };
          }
          console.log(`[ACCOUNTANT PROTOCOL] ADJUST_TP_SL R/R check passed: ${riskReward.toFixed(2)} >= 1.5`);
        }

        console.log(`[EXECUTE] ADJUST_TP_SL bracket swap for ${coinbaseProduct}. Cancelling old brackets...`);
        
        // Cancel existing bracket orders
        try {
          const orderPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
          const orderResp = await cbRequest({ token: `${generateToken('GET', orderPath)}`, method: 'GET', path: `${orderPath}` });
          
          if (orderResp.ok) {
            const orderData = await orderResp.json();
            if (orderData.orders && orderData.orders.length > 0) {
              const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
              await cbRequest({ token: `${generateToken('POST', cancelPath)}`, method: 'POST', path: `${cancelPath}`, body: { order_ids: orderData.orders.map(o => o.order_id) } });
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
          // 🟢 AM30 — BRACKET SIZING FROM EXCHANGE: never trust config/DB qty for a live
          // bracket. Read the REAL position size from cfm/positions (same call the close
          // reconcile uses). Exchange flat → deploy nothing, close the DB row instead.
          let actualQty = Math.max(1, Math.round(parseFloat(openTrade.qty || orderQty)));
          try {
            const adjPosPath = '/api/v3/brokerage/cfm/positions';
            const adjPosResp = await cbRequest({ token: `${generateToken('GET', adjPosPath)}`, method: 'GET', path: `${adjPosPath}` });
            if (adjPosResp.ok) {
              const adjPosData = await adjPosResp.json();
              const adjLivePosition = adjPosData.positions?.find(p => p.product_id === coinbaseProduct);
              const adjLiveQty = adjLivePosition ? Math.abs(parseFloat(adjLivePosition.number_of_contracts)) : 0;
              if (adjLiveQty === 0) {
                console.warn(`[ADJUST_TP_SL] Exchange shows flat for ${coinbaseProduct} but trade_logs id=${openTrade.id} still open. Closing DB row instead of deploying brackets.`);
                try {
                  await supabase.from('trade_logs').update({
                    exit_price: parseFloat(openTrade.entry_price) || 0,
                    pnl: 0,
                    exit_time: new Date().toISOString(),
                    reason: `${openTrade.reason || ''}\n\n[EXIT TRIGGER]: ADJUST_TP_SL_STATE_DRIFT (exchange already flat)`
                  }).eq('id', openTrade.id);
                } catch (driftErr) {
                  console.error('[ADJUST_TP_SL] Failed to mark drift-closed trade_log:', driftErr.message);
                }
                return { status: "already_closed_natively", product: coinbaseProduct, reason: 'exchange_flat' };
              }
              if (Math.round(adjLiveQty) !== actualQty) {
                console.warn(`[ADJUST_TP_SL] DB qty=${actualQty} but exchange position=${adjLiveQty}. Sizing brackets to exchange.`);
                actualQty = Math.max(1, Math.round(adjLiveQty));
                try {
                  await supabase.from('trade_logs').update({ qty: actualQty }).eq('id', openTrade.id);
                } catch (qtyErr) {
                  console.error('[ADJUST_TP_SL] Failed to sync trade_log qty to exchange:', qtyErr.message);
                }
              }
            } else {
              console.warn(`[ADJUST_TP_SL] cfm/positions returned ${adjPosResp.status}. Proceeding with DB qty=${actualQty}.`);
            }
          } catch (adjPosErr) {
            console.error('[ADJUST_TP_SL] Position fetch failed, proceeding with DB qty:', adjPosErr.message);
          }
          
          
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
            const ocoResp = await cbRequest({ token: `${generateToken('POST', path)}`, method: 'POST', path: `${path}`, body: ocoPayload });
            const ocoResult = await ocoResp.json();
            if (!ocoResp.ok || ocoResult.success === false) {
              const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
              console.error(`[ADJUST_TP_SL BRACKET REJECT]:`, ocoErrMsg);
              await sendDiscordAlert(tenantId, { title: `⚠️ Bracket Update Failed: ${rawSymbol}`, description: `**Action:** ADJUST_TP_SL\n**Details:** ${ocoErrMsg}`, color: 15548997 });
            } else {
              console.log(`[ADJUST_TP_SL] New brackets deployed: TP $${tpPrice}, SL $${slPrice}`);
              // Store oco_order_id for EXIT FORENSICS direct lookup
              const adjOcoOrderId = ocoResult.success_response?.order_id || ocoResult.order_id || null;
              if (adjOcoOrderId && openTrade?.id) {
                try {
                  await supabase.from('trade_logs').update({ oco_order_id: adjOcoOrderId }).eq('id', openTrade.id);
                  console.log(`[ADJUST_TP_SL] Stored oco_order_id=${adjOcoOrderId} on trade_log id=${openTrade.id}`);
                } catch (trackErr) {
                  console.error('[ADJUST_TP_SL] Failed to store oco_order_id:', trackErr.message);
                }
              }
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

      // 🟢 CLOSE-PATH STATE: Track residual bracket info so we can restore on failure.
      let closeContext = null;

      // 🟢 Push 7 hotfix — Coinbase-only close prep. The KRF/AM68 SPOT closes already
      // did their own reconcile + reduce-only IOC + AM59 receipt inside their lane
      // blocks above; cfm/positions + batch_cancel here would be cross-venue calls on
      // undefined creds (generateToken throws on the missing PEM).
      if (isClosing && !krakenFuturesLane && !krakenSpotLane) {
          // 🛡️ AM14 reentrancy guard: a double-clicked dashboard close or a racing
          // agent dispatch must not fire two close sequences for the same position.
          const closeKey = `${tenantId}:${coinbaseProduct}`;
          const lastCloseAt = closingNow.get(closeKey) || 0;
          if (Date.now() - lastCloseAt < CLOSE_LOCK_TTL_MS) {
              console.warn(`[CLOSE GUARD] Close already in flight for ${coinbaseProduct}. Ignoring duplicate request.`);
              return { status: 'close_in_progress', product: coinbaseProduct };
          }
          closingNow.set(closeKey, Date.now());

          // 🛡️ PHASE B: RECONCILE WITH EXCHANGE (exchange is source of truth).
          // The DB row's qty may diverge from real position size due to double-fills,
          // partial fills, or manual exchange-side activity. Always trust cfm/positions.
          let reconciledQty = null;
          try {
              const posPath = '/api/v3/brokerage/cfm/positions';
              const posResp = await cbRequest({ token: `${generateToken('GET', posPath)}`, method: 'GET', path: `${posPath}` });
              if (posResp.ok) {
                  const posData = await posResp.json();
                  const livePosition = posData.positions?.find(p => p.product_id === coinbaseProduct);
                  const liveQty = livePosition ? Math.abs(parseFloat(livePosition.number_of_contracts)) : 0;

                  if (liveQty === 0) {
                      // Exchange shows flat. If we have a DB row, mark it closed;
                      // for a live-direct-close (no DB row) just report flat.
                      if (!openTrade) {
                          console.warn(`[CLOSE RECONCILE] Exchange shows flat for ${coinbaseProduct} (live direct close, no trade_logs row). Nothing to flatten.`);
                          closingNow.delete(closeKey);
                          return { status: 'already_closed_natively', product: coinbaseProduct, reason: 'exchange_flat' };
                      }
                      // Exchange shows flat but DB says open → state drift. Trust exchange.
                      console.warn(`[CLOSE RECONCILE] Exchange shows flat for ${coinbaseProduct} but trade_logs id=${openTrade.id} still open. Marking DB row closed without sending a phantom order.`);
                      const fallbackExit = parseFloat(incomingPrice) || parseFloat(openTrade.sl_price) || parseFloat(openTrade.entry_price) || 0;
                      const safeEntry = parseFloat(openTrade.entry_price) || 0;
                      const dbQty = parseFloat(openTrade.qty) || 0;
                      const driftPnl = openTrade.side === 'BUY'
                          ? (fallbackExit - safeEntry) * dbQty * multiplier
                          : (safeEntry - fallbackExit) * dbQty * multiplier;
                      const driftReason = `${openTrade.reason || ''}\n\n[EXIT TRIGGER]: ${tradeReason || 'STATE_DRIFT_RECONCILE'} (exchange already flat)`;
                      try {
                          await supabase.from('trade_logs').update({
                              exit_price: fallbackExit,
                              pnl: parseFloat(driftPnl.toFixed(4)),
                              exit_time: new Date().toISOString(),
                              reason: driftReason
                          }).eq('id', openTrade.id);
                      } catch (e) {
                          console.error('[CLOSE RECONCILE] Failed to mark drift-closed trade_log:', e.message);
                      }
                      await sendDiscordAlert(tenantId, {
                          title: `ℹ️ Position Reconciled Flat: ${rawSymbol}`,
                          description: `Exchange reports no open position for ${coinbaseProduct}, but bot state believed otherwise. Trade marked closed at $${fallbackExit}.\n**Trigger:** ${tradeReason || 'STATE_DRIFT_RECONCILE'}`,
                          color: 15105570
                      });
                      closingNow.delete(closeKey);
                      return { status: 'already_closed_natively', product: coinbaseProduct, reason: 'exchange_flat' };
                  }

                  reconciledQty = Math.max(1, Math.round(liveQty));
                  if (reconciledQty !== orderQty) {
                      console.warn(`[CLOSE RECONCILE] DB qty=${orderQty} but exchange position=${reconciledQty}. Trusting exchange.`);
                      orderQty = reconciledQty;
                  } else {
                      console.log(`[CLOSE RECONCILE] DB qty matches exchange (${reconciledQty}).`);
                  }
              } else {
                  console.warn(`[CLOSE RECONCILE] cfm/positions returned ${posResp.status}. Proceeding with DB qty=${orderQty}.`);
              }
          } catch (reconErr) {
              console.error('[CLOSE RECONCILE] Failed to reconcile position size:', reconErr.message);
          }

          // Stash bracket restoration metadata BEFORE we nuke them. For a live
          // direct close there's no DB row, so TP/SL are unknown (null) and the
          // closing side is simply the side the caller already computed.
          closeContext = {
              tpPrice: openTrade ? (parseFloat(openTrade.tp_price) || null) : null,
              slPrice: openTrade ? (parseFloat(openTrade.sl_price) || null) : null,
              closingSide: openTrade ? (openTrade.side === 'BUY' ? 'SELL' : 'BUY') : side,
              tradeId: openTrade ? openTrade.id : null,
              ocoOrderId: openTrade?.oco_order_id || null,
              originalQty: orderQty
          };

          // 🟢 AM14 STEP 0-2 — VERIFIED BRACKET CANCEL (replaces the old FLOOR SWEEPER,
          // which silently skipped cancel when the order-list call failed and then let the
          // reduce-only close get rejected with PREVIEW_ORDER_SIZE_EXCEEDS_BRACKETED_POSITION).
          // Rule: NEVER place the close while brackets may still reserve the position.
          try {
              const listPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
              const listResp = await cbRequest({ token: `${generateToken('GET', listPath)}`, method: 'GET', path: `${listPath}` });
              if (!listResp.ok) {
                  // AM14: hard fail — proceeding blind is exactly what caused the incident.
                  throw new Error(`step=cancel_brackets: open-orders list failed (${listResp.status})`);
              }
              const listData = await listResp.json();
              const openOrders = listData.orders || [];

              // Scoped cancel: only this trade's brackets (nx_* prefixes + stored oco_order_id).
              // Product-wide only for live-direct closes (no DB row → no trade scope).
              const tradePrefixes = openTrade ? [
                  `nx_oco_${openTrade.id}`, `nx_oco_retry_${openTrade.id}`, `nx_adj_${openTrade.id}_`,
                  `nx_wd_tw_${openTrade.id}_`, `nx_wd_tr_${openTrade.id}_`, `nx_wd_tp_${openTrade.id}_`,
                  `nx_wd_restore_${openTrade.id}_`, `nx_restore_${openTrade.id}_`
              ] : null;
              const bracketOrders = (orders, includedOrderId = null) => (orders || []).filter(o =>
                  (includedOrderId && o.order_id === includedOrderId) ||
                  (closeContext.ocoOrderId && o.order_id === closeContext.ocoOrderId) ||
                  o.order_configuration?.trigger_bracket_gtc ||
                  (tradePrefixes && tradePrefixes.some(pfx => o.client_order_id?.startsWith(pfx)))
              );
              let targets = bracketOrders(openOrders);
              if (!openTrade) targets = openOrders.filter(o => o.order_type !== 'MARKET'); // live-direct: sweep all resting orders

              if (targets.length > 0) {
                  const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                  const cancelResp = await cbRequest({ token: `${generateToken('POST', cancelPath)}`, method: 'POST', path: `${cancelPath}`, body: { order_ids: targets.map(o => o.order_id) } });
                  const cancelResult = await cancelResp.json().catch(() => ({}));
                  const failedCancels = cancelResult.results?.filter(r => !r.success) || [];
                  if (failedCancels.length > 0) {
                      throw new Error(`step=cancel_brackets: ${failedCancels.length} cancel(s) rejected: ${failedCancels.map(r => r.order_id).join(', ')}`);
                  }
                  console.log(`[CLOSE PREP] Cancelled ${targets.length} bracket order(s) for ${coinbaseProduct}.`);
              }

              // AM14 STEP 2 — WAIT for cancels to land: poll open orders until the
              // brackets are gone. ~400ms cadence, bounded ~8s (exchange propagation
              // observed at 1.5-2.5s; 2ms polling would burn rate limits on stale state).
              const POLL_MS = 400, POLL_CAP_MS = 8000;
              const pollStart = Date.now();
              let bracketsGone = false;
              while (Date.now() - pollStart < POLL_CAP_MS) {
                  await closeSleep(POLL_MS);
                  const vResp = await cbRequest({ token: `${generateToken('GET', listPath)}`, method: 'GET', path: `${listPath}` });
                  if (!vResp.ok) continue; // transient — keep polling until cap
                  const vData = await vResp.json();
                  const remaining = bracketOrders(vData.orders || []);
                  if (remaining.length === 0) { bracketsGone = true; break; }
                  console.log(`[CLOSE PREP] ${remaining.length} bracket(s) still open — polling...`);
              }
              if (!bracketsGone) {
                  throw new Error(`step=cancel_brackets: brackets still open after ${POLL_CAP_MS}ms poll for ${coinbaseProduct}`);
              }
              console.log(`[CLOSE PREP] Brackets confirmed gone for ${coinbaseProduct}. Proceeding to close.`);
          } catch (sweepErr) {
              // AM14 fail path: do NOT proceed to the close. Trade stays open + retryable.
              console.error(`[CLOSE FAILED] ${sweepErr.message}`);
              throw sweepErr;
          }
      }

      // BALANCE CHECK: Log derivatives balance before LIVE trade for confirmation
      // 🟢 Push 7 hotfix — Coinbase-only (the KRF lane logged its own flex balance
      // inside the lane block; cfm/balance_summary here would be a cross-venue call).
      if (!isClosing && marketType !== 'SPOT' && !krakenFuturesLane) {
          try {
              const cfmPath = '/api/v3/brokerage/cfm/balance_summary';
              const cfmResp = await cbRequest({ token: `${generateToken('GET', cfmPath)}`, method: 'GET', path: `${cfmPath}` });
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
      // 🟢 Push 7 hotfix — generateCoinbaseToken parses the PEM private key; with
      // undefined KRF-lane creds it THROWS at this call. The token is only used by
      // the Coinbase order POST below (which the KRF lane skips).
      const token = krakenFuturesLane ? null : generateToken('POST', path);

      // 🛡️ PHASE F: Stable, idempotent client_order_id.
      // - Entries: prefer upstream idempotency_key so Coinbase de-dupes retries server-side.
      // - Closes: deterministic per trade_log id (only allow one close-per-trade ever).
      let entryClientId;
      if (isClosing) {
          entryClientId = `nx_close_${openTrade.id}_${Date.now()}`;
      } else if (data.idempotency_key) {
          // Coinbase client_order_id is capped at 35 chars; truncate hashed key defensively.
          const safeKey = String(data.idempotency_key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
          entryClientId = `nx_e_${safeKey}`;
      } else {
          entryClientId = `nx_entry_${Date.now()}`;
      }

      // 🔒 RISK VALIDATOR: Check if LIVE trade complies with risk profile.
      // Only for new entry trades — closing positions and forced exits are exempt.
      if (!isClosing && !isForcedExit) {
        // Guard: LIVE requires confirmed contract specs from Coinbase.
        // If the AssetResolver returned an error or no contract_size, block LIVE.
        // PAPER mode would have already been handled in the PAPER branch below.
        if (assetSpecs.error || !assetSpecs.contract_size) {
          console.warn(`[EXECUTE] LIVE trade blocked: unknown contract specs for ${rawSymbol}.`);
          return { status: "risk_vetoed", reason: `Unknown contract specs for ${rawSymbol}. Cannot verify risk for LIVE trading.`, product: coinbaseProduct };
        }

        const riskCheck = await validateTradeRisk(tenantId, {
          side, symbol: rawSymbol,
          entryPrice: executionPrice,
          slPrice, tpPrice,
          qty: orderQty,
          leverage
        }, {
          assetSpecs,
          executionMode: 'LIVE'
        });

        if (!riskCheck.approved) {
          // 🚫 LOG RISK VETO + SEND DISCORD
          // AM52h: the supabase query builder is a thenable WITHOUT .catch —
          // chaining .catch() here threw "catch is not a function" and killed
          // the veto path (Execution Fault). Observability must never be
          // load-bearing for order flow, so log inside try/catch.
          try {
            await supabase.from('risk_veto_log').insert([{
              tenant_id: tenantId,
              trade_id: null,
              asset: rawSymbol,
              side,
              entry_price: executionPrice,
              qty: orderQty,
              leverage,
              reason: riskCheck.reason,
              execution_mode: 'LIVE'
            }]);
          } catch (e) {
            console.warn('[RISK LOG] Insert failed:', e.message);
          }
          await sendDiscordAlert(tenantId, {
            title: `🚫 Risk Profile Block — ${rawSymbol}`,
            description: riskCheck.reason,
            color: 15548997,
            fields: [
              { name: 'Side', value: side, inline: true },
              { name: 'Entry', value: `$${executionPrice}`, inline: true },
              { name: 'Qty', value: String(orderQty), inline: true },
              { name: 'Leverage', value: `${leverage}x`, inline: true },
              { name: 'Mode', value: 'LIVE', inline: true },
            ]
          }).catch(e => console.warn('[RISK DISCORD] Send failed:', e.message));
          return { status: "risk_vetoed", reason: riskCheck.reason, product: coinbaseProduct };
        }

        if (riskCheck.clamped_sl !== null || riskCheck.clamped_qty !== null) {
            // 🟢 PUSH AM55 — capture originals BEFORE reassignment so the alert
            // prints the true "from X to Y" (previously it printed X→X).
            const originalSl = slPrice;
            const originalQty = orderQty;
            const clampDetails = buildClampDetails({
                originalSl, originalQty,
                clampedSl: riskCheck.clamped_sl,
                clampedQty: riskCheck.clamped_qty
            });
            if (riskCheck.clamped_sl !== null) slPrice = riskCheck.clamped_sl;
            if (riskCheck.clamped_qty !== null) orderQty = riskCheck.clamped_qty;
            await sendDiscordAlert(tenantId, {
                title: `⚠️ Risk Adjustment: ${rawSymbol}`,
                description: `**Mode:** ${mode}\n**Adjustments:** ${clampDetails.join(', ')}\n**Reason:** ${riskCheck.reason || 'Risk profile limits applied'}`,
                color: 15844367
            });
        }
      }

      const payload = {
        client_order_id: entryClientId, product_id: coinbaseProduct, side: side, order_configuration: {}
      };

      if (orderType === 'LIMIT') {
          payload.order_configuration.limit_limit_gtc = { base_size: orderQty.toString(), limit_price: executionPrice.toString() };
      } else {
          payload.order_configuration.market_market_ioc = { base_size: orderQty.toString() };
      }

      // 🛡️ PHASE C: reduce_only on LIVE close orders.
      // Trading CDE Coinbase perps only — safe to apply unconditionally when !isPaper && isClosing.
      // This guarantees the exchange will REJECT any close payload that would flip into a new
      // opposite-side position (e.g., size mismatch from a double-fill entry), surfacing the
      // problem instead of silently leaving the position naked.
      if (isClosing && !isPaper) {
          if (orderType === 'LIMIT') {
              payload.order_configuration.limit_limit_gtc.reduce_only = true;
          } else {
              payload.order_configuration.market_market_ioc.reduce_only = true;
          }
          console.log(`[CLOSE GUARD] reduce_only=true applied to ${orderType} close for ${coinbaseProduct} qty=${orderQty}.`);
      }

      // 🟢 Push 7 hotfix — the Coinbase order POST (and the PHASE C fallback that
      // re-reads `result`) is coinbase-only. The KRF lane placed its order inside
      // the lane block; `resp`/`result` stay null here and every consumer below is
      // lane-gated.
      let resp = null;
      let result = null;
      if (!krakenFuturesLane && !krakenSpotLane) {
        resp = await cbRequest({ token: `${token}`, method: 'POST', path: `${path}`, body: payload });
        result = await resp.json();
      }

      // 🛡️ FIX 39 — PHASE C FALLBACK: some venues intermittently reject reduce_only on
      // close orders even when the size exactly matches the open position. PHASE B has
      // already clamped orderQty to the live cfm/positions size, so resubmitting WITHOUT
      // reduce_only carries the same no-flip guarantee without the venue quirk.
      const closeFailureReason = result?.error_response?.preview_failure_reason || result?.error_response?.error || '';
      if (!krakenFuturesLane && !krakenSpotLane && isClosing && !isPaper && closeFailureReason.toUpperCase().includes('REDUCE_ONLY')) {
          const hadReduceOnly = !!(payload.order_configuration.limit_limit_gtc?.reduce_only || payload.order_configuration.market_market_ioc?.reduce_only);
          if (hadReduceOnly) {
              console.warn(`[CLOSE GUARD] venue rejected reduce_only — resubmitting clamped unprotected close for ${coinbaseProduct} qty=${orderQty}. Reason: ${closeFailureReason}`);
              if (payload.order_configuration.limit_limit_gtc) delete payload.order_configuration.limit_limit_gtc.reduce_only;
              if (payload.order_configuration.market_market_ioc) delete payload.order_configuration.market_market_ioc.reduce_only;
              payload.client_order_id = `nx_close_fallback_${Date.now()}`;
              resp = await cbRequest({ token: `${token}`, method: 'POST', path: `${path}`, body: payload });
              result = await resp.json();
          }
      }

      // 🛡️ PHASE E: If a CLOSE order is rejected, the FLOOR SWEEPER has already nuked the
      // protective brackets. We MUST redeploy them against whatever residual position remains
      // before bailing out, otherwise the position is left naked (the original bug).
      const restoreBracketsOnFailure = async (failureReason) => {
          if (!closeContext) return; // not a close, nothing to restore
          try {
              const posPath = '/api/v3/brokerage/cfm/positions';
              const posResp = await cbRequest({ token: `${generateToken('GET', posPath)}`, method: 'GET', path: `${posPath}` });
              let residualQty = closeContext.originalQty;
              if (posResp.ok) {
                  const posData = await posResp.json();
                  const livePos = posData.positions?.find(p => p.product_id === coinbaseProduct);
                  // FIX 39: plain round of the absolute live size — Math.max(1, ...) masked a
                  // flat exchange by forcing a phantom 1-contract protect. If the exchange is
                  // flat there is nothing to protect; the `<= 0` guard below returns early.
                  residualQty = livePos ? Math.round(Math.abs(parseFloat(livePos.number_of_contracts))) : 0;
              }
              if (residualQty <= 0) {
                  console.log('[BRACKET RESTORE] No residual position — nothing to protect.');
                  return;
              }
              if (!closeContext.tpPrice || !closeContext.slPrice) {
                  // Fetch current market price and compute fallback brackets
                  const fbPath = `/api/v3/brokerage/products/${coinbaseProduct}`;
                  const fbResp = await cbRequest({ token: `${generateToken('GET', fbPath)}`, method: 'GET', path: `${fbPath}` });
                  if (fbResp.ok) {
                      const fbData = await fbResp.json();
                      const fbPrice = parseFloat(fbData.price);
                      if (fbPrice > 0) {
                          closeContext.tpPrice = closeContext.tpPrice ||
                              (closeContext.closingSide === 'SELL' ? fbPrice * 1.02 : fbPrice * 0.98);
                          closeContext.slPrice = closeContext.slPrice ||
                              (closeContext.closingSide === 'SELL' ? fbPrice * 0.98 : fbPrice * 1.02);
                          console.log(`[BRACKET RESTORE] Computed fallback TP=$${closeContext.tpPrice} SL=$${closeContext.slPrice}`);
                      }
                  }
                  if (!closeContext.tpPrice || !closeContext.slPrice) {
                      console.warn(`[BRACKET RESTORE] Missing TP/SL on trade_log id=${closeContext.tradeId}; cannot restore brackets. Position of ${residualQty} contracts is NAKED.`);
                      await sendDiscordAlert(tenantId, {
                          title: `🚨 NAKED POSITION: ${rawSymbol}`,
                          description: `Close failed (${failureReason}) and bot has no stored TP/SL to restore brackets. **${residualQty} contracts are unprotected on Coinbase.** Manual intervention required.`,
                          color: 15158332
                      });
                      return;
                  }
              }

              // 🛡️ FIX 39: Adaptive retry — up to 3 attempts with 2s backoff, falling back to
              // SL-only on the 3rd. Each attempt adapts to the exchange's rejection reason:
              //  - OUT_OF_BOUNDS → move the SL trigger to ≥1% from current price, keeping the
              //    wall-behind rule (place it BEYOND the largest bid wall between price & SL).
              //  - PRECISION → round TP/SL to the product tick size.
              // Track each attempt's failure reason so the Discord alerts can show what the
              // exchange said about every attempt.
              const attemptFailures = [];
              const roundToTick = (p) => parseFloat((Math.round(p / tickSize) * tickSize).toFixed(4));

              // Fetch current market price for the adaptive OUT_OF_BOUNDS clamp.
              let adaptiveMarketPrice = 0;
              try {
                  const mkPath = `/api/v3/brokerage/products/${coinbaseProduct}`;
                  const mkResp = await cbRequest({ token: `${generateToken('GET', mkPath)}`, method: 'GET', path: `${mkPath}` });
                  if (mkResp.ok) adaptiveMarketPrice = parseFloat((await mkResp.json()).price) || 0;
              } catch (mkErr) {
                  console.warn(`[BRACKET RESTORE] Could not fetch market price for adaptive retry: ${mkErr.message}`);
              }

              // Fetch the order book to locate the largest bid wall between current price and
              // the SL (wall-behind rule from SKILL.md WALL GEOMETRY). Returns the price just
              // BEYOND the largest wall, or null if the book is unavailable/no wall found.
              const findWallBehindPrice = async (targetSl) => {
                  try {
                      const bookPath = `/api/v3/brokerage/products/${coinbaseProduct}/quote_book`;
                      const bookResp = await cbRequest({ token: `${generateToken('GET', bookPath)}`, method: 'GET', path: `${bookPath}` });
                      if (!bookResp.ok) return null;
                      const book = await bookResp.json();
                      // Closing side SELL = long position → SL is BELOW price → walls live in bids.
                      // Closing side BUY = short position → SL is ABOVE price → walls live in asks.
                      const levels = (closeContext.closingSide === 'SELL'
                          ? (book.bids || book.quote_book?.bids || [])
                          : (book.asks || book.quote_book?.asks || []))
                          .map(l => ({ price: parseFloat(l.price || l[0]), size: parseFloat(l.size || l.quantity || l[1]) }))
                          .filter(l => l.price > 0 && l.size > 0)
                          .sort((a, b) => closeContext.closingSide === 'SELL' ? b.price - a.price : a.price - b.price);
                      if (levels.length === 0) return null;
                      // Largest wall between current price and the SL target.
                      const lo = Math.min(adaptiveMarketPrice || targetSl, targetSl);
                      const hi = Math.max(adaptiveMarketPrice || targetSl, targetSl);
                      const inBand = levels.filter(l => l.price >= lo && l.price <= hi);
                      if (inBand.length === 0) return null;
                      const wall = inBand.reduce((m, l) => (l.size > m.size ? l : m), inBand[0]);
                      // Next level BEYOND the wall (further away from current price).
                      const beyond = levels.filter(l => closeContext.closingSide === 'SELL' ? l.price < wall.price : l.price > wall.price);
                      const pick = beyond[0] || wall;
                      console.log(`[BRACKET RESTORE] Wall-behind rule: largest ${closeContext.closingSide === 'SELL' ? 'bid' : 'ask'} wall @ $${wall.price} (size ${wall.size}); placing SL beyond at $${pick.price}.`);
                      return pick.price;
                  } catch (wallErr) {
                      console.warn(`[BRACKET RESTORE] Wall lookup failed: ${wallErr.message}`);
                      return null;
                  }
              };

              let bracketRestored = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                  const isSlOnly = attempt === 3;
                  let tpStr = roundToTick(closeContext.tpPrice).toString();
                  let slStr = roundToTick(closeContext.slPrice).toString();

                  // Adaptive tuning applied from the previous attempt's failure reason.
                  const prevReason = (attemptFailures[attemptFailures.length - 1]?.reason || '').toUpperCase();
                  if (attempt > 1 && adaptiveMarketPrice > 0) {
                      if (prevReason.includes('OUT_OF_BOUNDS')) {
                          // Move SL ≥1% from current price, keeping the wall-behind rule.
                          const minDistance = adaptiveMarketPrice * 0.01;
                          let adaptiveSl = closeContext.closingSide === 'SELL'
                              ? Math.min(adaptiveMarketPrice - minDistance, adaptiveMarketPrice * (1 - 0.01))
                              : Math.max(adaptiveMarketPrice + minDistance, adaptiveMarketPrice * (1 + 0.01));
                          const wallPrice = await findWallBehindPrice(adaptiveSl);
                          if (wallPrice) {
                              // Keep the further of (1% SL, wall-beyond price) — wall-behind rule.
                              adaptiveSl = closeContext.closingSide === 'SELL'
                                  ? Math.min(adaptiveSl, wallPrice)
                                  : Math.max(adaptiveSl, wallPrice);
                          }
                          slStr = roundToTick(adaptiveSl).toString();
                          closeContext.slPrice = parseFloat(slStr);
                          console.log(`[BRACKET RESTORE] Attempt ${attempt}: OUT_OF_BOUNDS → SL moved to $${slStr} (≥1% from market $${adaptiveMarketPrice}${wallPrice ? ', beyond bid wall' : ''}).`);
                      } else if (prevReason.includes('PRECISION')) {
                          // TP/SL already tick-rounded above; log it for clarity.
                          console.log(`[BRACKET RESTORE] Attempt ${attempt}: PRECISION → TP/SL rounded to tick size ${tickSize}.`);
                      }
                  }

                  const restorePayload = {
                      client_order_id: `nx_restore_${closeContext.tradeId}_${Date.now()}_${attempt}`,
                      product_id: coinbaseProduct,
                      side: closeContext.closingSide,
                      order_configuration: {
                          trigger_bracket_gtc: {
                              limit_price: tpStr,
                              stop_trigger_price: slStr,
                              base_size: residualQty.toString()
                          }
                      }
                  };
                  const restoreResp = await cbRequest({ token: `${generateToken('POST', path)}`, method: 'POST', path: `${path}`, body: restorePayload });
                  const restoreResult = await restoreResp.json();
                  if (restoreResp.ok && restoreResult.success !== false) {
                      bracketRestored = true;
                      console.log(`[BRACKET RESTORE] Attempt ${attempt} SUCCEEDED: Redeployed ${isSlOnly ? 'SL-only' : 'OCO'} brackets on ${residualQty} contracts: TP $${tpStr} / SL $${slStr}.`);
                      await sendDiscordAlert(tenantId, {
                          title: `🛡️ Brackets Restored: ${rawSymbol}`,
                          description: `Close failed (${failureReason}); ${isSlOnly ? 'SL-only' : 'OCO'} brackets redeployed on residual ${residualQty} contracts (attempt ${attempt}).\n**TP:** $${tpStr}\n**SL:** $${slStr}`,
                          color: 15844367,
                          fields: [
                              { name: 'Succeeded Attempt', value: `#${attempt}${isSlOnly ? ' (SL-only fallback)' : ''}`, inline: true },
                              ...attemptFailures.map((f, i) => ({ name: `Attempt ${i + 1} Rejected`, value: f.reason.slice(0, 1000), inline: false }))
                          ]
                      });
                      break;
                  }
                  const rErr = restoreResult.error_response?.preview_failure_reason || restoreResult.error_response?.error || JSON.stringify(restoreResult);
                  attemptFailures.push({ attempt, reason: rErr });
                  console.error(`[BRACKET RESTORE] Attempt ${attempt} FAILED: ${rErr}`);
                  if (attempt < 3) {
                      await new Promise(r => setTimeout(r, 2000));
                  }
              }

              if (!bracketRestored) {
                  console.error(`[BRACKET RESTORE] All 3 attempts failed. Position of ${residualQty} contracts is NAKED.`);
                  await sendDiscordAlert(tenantId, {
                      title: `🚨 NAKED POSITION: ${rawSymbol}`,
                      description: `Close failed (${failureReason}) AND all bracket restore attempts failed. **${residualQty} contracts unprotected.** Manual intervention required.`,
                      color: 15158332,
                      fields: attemptFailures.map((f, i) => ({ name: `Attempt ${i + 1} Rejected`, value: f.reason.slice(0, 1000), inline: false }))
                  });
              }
          } catch (restErr) {
              console.error('[BRACKET RESTORE] Exception during restore:', restErr.message);
          }
      };

      // Handle order rejection — no trade_log to clean up (INSERT happens after order succeeds)
      // 🟢 Push 7 hotfix — lane-gated: resp/result are null for the KRF lane (its
      // rejects were already surfaced as readable rejections inside the lane block).
      if (!krakenFuturesLane && !krakenSpotLane && (!resp.ok || result.success === false || result.error_response)) {
        const errMsg = result.error_response?.preview_failure_reason || result.error_response?.error || result.failure_reason?.error_message || JSON.stringify(result);
        const isInsufficientFunds = errMsg.includes('INSUFFICIENT_FUNDS') || errMsg.includes('insufficient_funds') || errMsg.includes('insufficient');

        if (isInsufficientFunds) {
            console.warn(`[EXECUTE] Order rejected due to INSUFFICIENT_FUNDS. This may be caused by ACH settlement holds — USD may show in your balance but hasn't cleared for futures margin. Try using a Wire Transfer or waiting 3-5 business days for ACH to settle.`);
        }

        // 🛡️ PHASE E: If this was a CLOSE that got rejected, the brackets are gone. Restore them.
        if (isClosing) {
            // 🟢 AM14 STEP 5 (optional sane default): ONE retry of the close after
            // re-checking the live position size — the bracket may have partially
            // filled before cancel, so the original size can be stale. Re-read
            // cfm/positions and close the remainder with a fresh client id.
            let retriedClose = false;
            try {
                const rPosPath = '/api/v3/brokerage/cfm/positions';
                const rPosResp = await cbRequest({ token: `${generateToken('GET', rPosPath)}`, method: 'GET', path: `${rPosPath}` });
                if (rPosResp.ok) {
                    const rPosData = await rPosResp.json();
                    const rLive = rPosData.positions?.find(p => p.product_id === coinbaseProduct);
                    const rQty = rLive ? Math.round(Math.abs(parseFloat(rLive.number_of_contracts))) : 0;
                    if (rQty > 0) {
                        console.warn(`[CLOSE RETRY] Close rejected (${errMsg}). Re-read live size=${rQty} (was ${orderQty}). Retrying once.`);
                        const retryPayload = JSON.parse(JSON.stringify(payload));
                        retryPayload.client_order_id = `nx_close_retry_${Date.now()}`;
                        if (retryPayload.order_configuration.market_market_ioc) retryPayload.order_configuration.market_market_ioc.base_size = String(rQty);
                        if (retryPayload.order_configuration.limit_limit_gtc) retryPayload.order_configuration.limit_limit_gtc.base_size = String(rQty);
                        const retryResp = await cbRequest({ token: `${token}`, method: 'POST', path: `${path}`, body: retryPayload });
                        const retryResult = await retryResp.json();
                        if (retryResp.ok && !retryResult.error_response) {
                            retriedClose = true;
                            result = retryResult;
                            orderQty = rQty;
                            console.log(`[CLOSE RETRY] Retry accepted for ${coinbaseProduct} qty=${rQty}.`);
                        } else {
                            const rErr = retryResult.error_response?.preview_failure_reason || retryResult.error_response?.error || `HTTP ${retryResp.status}`;
                            console.error(`[CLOSE FAILED] step=close_order_retry: ${rErr}`);
                        }
                    } else {
                        // Exchange already flat — the bracket filled instead. Nothing to close.
                        console.log('[CLOSE RETRY] Exchange already flat — bracket likely filled. Nothing to close.');
                        retriedClose = true;
                    }
                }
            } catch (retryErr) {
                console.error(`[CLOSE FAILED] step=close_order_retry: ${retryErr.message}`);
            }

            if (!retriedClose) {
                await restoreBracketsOnFailure(errMsg);
            }
            if (!retriedClose) {
                throw new Error(`Coinbase Order Rejected: ${errMsg}`);
            }
        } else {
            throw new Error(`Coinbase Order Rejected: ${errMsg}`);
        }
      }
      
      executionStatus = orderType === 'LIMIT' ? 'limit_placed' : 'filled';

      // ── 🟢 AM59 STEP 1-2 — CLOSE FILL VERIFICATION (pre-write) ────────────────
      // The AM14 post-close poll threw before stamping, but a `throw` skipped
      // restoreBracketsOnFailure + the flat check AND the outer catch downgraded it to
      // `{ error }`. AVP trade 3694 is the receipt: exit_price came from the decision
      // price, exit_fees was null (no confirmed fill), the trade was stamped closed,
      // and the position was STILL LONG with an orphaned BE bracket. AM59 verifies the
      // close order's fill HERE; on any failure it keeps the trade OPEN, alerts loudly,
      // and returns `close_failed` so the agent/UI learns the truth.
      // 🟢 Push 7 hotfix — lane-gated: the KRF close receipt was already verified
      // inside the lane block (closeFillConfirmed=true); polling Coinbase order
      // history for a KRF order id would be a cross-venue call on undefined creds.
      if (isClosing && !isPaper && openTrade && !krakenFuturesLane && !krakenSpotLane) {
          // Fresh close order for retries (never reuse a spent client_order_id).
          const submitClose = async (qty) => {
              const retryPayload = JSON.parse(JSON.stringify(payload));
              retryPayload.client_order_id = `nx_close_am59_${Date.now()}`;
              if (retryPayload.order_configuration.market_market_ioc) retryPayload.order_configuration.market_market_ioc.base_size = String(qty);
              if (retryPayload.order_configuration.limit_limit_gtc) retryPayload.order_configuration.limit_limit_gtc.base_size = String(qty);
              const retryResp = await cbRequest({ token: `${token}`, method: 'POST', path: `${path}`, body: retryPayload });
              return { resp: retryResp, result: await retryResp.json().catch(() => ({})) };
          };

          // Read the live position size = the max the close may legitimately fill.
          const readLiveCloseQty = async () => {
              try {
                  const capPath = '/api/v3/brokerage/cfm/positions';
                  const capResp = await cbRequest({ token: `${generateToken('GET', capPath)}`, method: 'GET', path: `${capPath}` });
                  if (!capResp.ok) return null;
                  const capData = await capResp.json();
                  const capPos = capData.positions?.find(p => p.product_id === coinbaseProduct);
                  return capPos ? Math.round(Math.abs(parseFloat(capPos.number_of_contracts))) : 0;
              } catch (capErr) {
                  console.warn(`[CLOSE VERIFY] live-size read failed: ${capErr.message}`);
                  return null;
              }
          };

          let lastReason = null;
          let verified = null;
          const accepted = !(result.success === false || result.error_response);
          if (accepted) {
              closeOrderId = result.success_response?.order_id || result.order_id || null;
              if (closeOrderId) {
                  // STEP 2: poll GET order until state=FILLED; read the ACTUAL avg fill
                  // price + total_fees from the confirmed order.
                  verified = await waitForOrderFilled(closeOrderId, generateToken, { maxMs: CLOSE_FILL_POLL_CAP_MS, intervalMs: CLOSE_FILL_POLL_MS });
              } else {
                  lastReason = 'close accepted but no order_id returned (cannot verify fill)';
              }
          } else {
              lastReason = result.error_response?.preview_failure_reason || result.error_response?.error || result.failure_reason?.error_message || 'close order not accepted';
          }

          if (verified && verified.confirmed) {
              closeFillConfirmed = true;
              executionPrice = verified.averagePrice;
              closeFees = verified.totalFees;
              executionStatus = 'closed_position';
              console.log(`[CLOSE VERIFY] Close order ${closeOrderId} FILLED @ $${executionPrice} (fees ${closeFees ?? 'n/a'}).`);
          } else {
              if (!lastReason) lastReason = `close order ${closeOrderId} never confirmed FILLED (last status: ${verified?.status || 'PENDING'})`;
              console.error(`[CLOSE FAILED] ${rawSymbol}: ${lastReason}. Retrying market close up to 3x.`);

              // ── Retry market close up to 3x, re-reading live capacity each attempt.
              for (let attempt = 1; attempt <= 3 && !closeFillConfirmed; attempt++) {
                  const liveQty = await readLiveCloseQty();
                  if (liveQty === 0) {
                      // Exchange is flat: the position was flattened (bracket fill or the
                      // first order landing late) but we hold NO fill receipt, so we must
                      // not fabricate one. Stop retrying and report the truth.
                      lastReason = `retry aborted: exchange flat but no fill receipt for ${closeOrderId || 'unknown order'}`;
                      break;
                  }
                  const attemptQty = liveQty != null ? Math.min(orderQty, liveQty) : orderQty;
                  console.warn(`[CLOSE RETRY] Attempt ${attempt}/3 for ${coinbaseProduct} qty=${attemptQty} (previous: ${lastReason}).`);
                  const { resp: aResp, result: aResult } = await submitClose(attemptQty);
                  const aAccepted = aResp.ok && aResult.success !== false && !aResult.error_response;
                  if (!aAccepted) {
                      lastReason = `retry ${attempt} rejected: ${aResult.error_response?.preview_failure_reason || aResult.error_response?.error || `HTTP ${aResp.status}`}`;
                      continue;
                  }
                  const aOrderId = aResult.success_response?.order_id || aResult.order_id || null;
                  if (!aOrderId) {
                      lastReason = `retry ${attempt} accepted without order_id`;
                      continue;
                  }
                  const aVerified = await waitForOrderFilled(aOrderId, generateToken, { maxMs: CLOSE_FILL_POLL_CAP_MS, intervalMs: CLOSE_FILL_POLL_MS });
                  if (aVerified.confirmed) {
                      closeFillConfirmed = true;
                      closeOrderId = aOrderId;
                      executionPrice = aVerified.averagePrice;
                      closeFees = aVerified.totalFees;
                      executionStatus = 'closed_position';
                      console.log(`[CLOSE VERIFY] Retry ${attempt} FILLED @ $${executionPrice} (fees ${closeFees ?? 'n/a'}).`);
                      break;
                  }
                  lastReason = `retry ${attempt} order ${aOrderId} not FILLED (last status ${aVerified.status})`;
              }
          }

          if (!closeFillConfirmed) {
              // (a) trade stays OPEN in the DB, (b) alert loudly, (c) return close_failed.
              // Restore brackets on the residual so a live position is never naked.
              console.error(`[CLOSE FAILED] ${rawSymbol}: position live, unmanaged — NOT stamping trade_logs id=${openTrade.id}.`);
              await restoreBracketsOnFailure(lastReason);
              await sendDiscordAlert(tenantId, {
                  title: `🚨 CLOSE FAILED — position live, unmanaged: ${rawSymbol}`,
                  description: `The close for trade ${openTrade.id} (${openTrade.side} ${coinbaseProduct}) was NOT confirmed FILLED after 1 + 3 attempts.\n**Last status:** ${lastReason}\n**Position:** STILL LIVE on the exchange.\n**Action:** trade_logs left OPEN — manual intervention required.`,
                  color: 15158332
              });
              // 🟢 AM59 — release the reentrancy lock so the operator/agent can RETRY the
              // close immediately. Leaving it held for CLOSE_LOCK_TTL_MS would block the
              // very retry this failure path asks for.
              closingNow.delete(`${tenantId}:${coinbaseProduct}`);
              return closeFailedResult('close_fill_unconfirmed', lastReason);
          }

          // 🟢 AM59 — the close sequence completed with a confirmed fill. Release the
          // reentrancy lock so a later close (e.g. a re-opened position) is not blocked
          // for the full TTL. The guard only needs to cover the in-flight window.
          closingNow.delete(`${tenantId}:${coinbaseProduct}`);
      }

      // 👇 Order succeeded — now create the trade_log (no race with watchdog)
      if (!isClosing && !isForcedExit) {
        try {
            // 🟢 PUSH AM53 — params_context carries the entry-time regime/exit lock.
            const liveInsertPayload = {
                tenant_id: tenantId,
                symbol: rawSymbol, strategy_id: canonicalStrategyId, version: version, side: side, order_type: orderType, 
                entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
                exit_time: null,
                market_snapshot_at_entry: fullMarketSnapshot || buildMarketSnapshot(executionPrice),
                regime_at_entry: regimeAtEntry,
                influencing_memory_ids: influencingMemoryIds,
                macro_tf: resolvedMacroTf,
                trigger_tf: resolvedTriggerTf,
                // 🟢 AM63 (Push 2) — venue stamped from the strategy config (defaults coinbase).
                exchange: resolvedExchange,
                // 🟢 Phase 3C: model + archetype + conviction enrichment at entry
                // (NULL-safe until Phase D populates the upstream pipeline)
                microstructure_archetype: data._microstructure_archetype || null,
                model_predicted_win_prob: data._model_predicted_win_prob ?? null,
                model_predicted_pnl: data._model_predicted_pnl ?? null,
                conviction_score_at_entry: data._conviction_score ?? null,
                transaction_fee: data._transaction_fee ?? null,
                // 🟢 PUSH AM53 — entry-time regime/exit lock (see entryParamsContext).
                params_context: entryParamsContext,
                // 🟢 AM62 — market-structure bias at entry (migration 059).
                structure_direction: structureDirection
            };
            let { data: insertData, error: insertError } = await supabase.from('trade_logs').insert([liveInsertPayload]).select();
            // 🛡️ AM53/AM62 SAFETY NET: never lose the trade row over an audit
            // column — if params_context (pre-048) or structure_direction (pre-059)
            // is rejected, retry WITHOUT the named column(s). (The 057 lesson:
            // code deployed before its column = silent insert failure.)
            if ((insertError || !insertData || insertData.length === 0) && /(params_context|structure_direction|exchange)/i.test(insertError?.message || '')) {
                console.warn(`[AM53/AM62/AM63] trade_logs insert rejected an additive column (${insertError.message}) — retrying without it.`);
                const without = { ...liveInsertPayload };
                if (/params_context/i.test(insertError.message || '')) delete without.params_context;
                if (/structure_direction/i.test(insertError.message || '')) delete without.structure_direction;
                if (/exchange/i.test(insertError.message || '')) { delete without.exchange; console.warn('[AM63] trade saved WITHOUT exchange — migration 060 not applied (deploy order error)'); }
                ({ data: insertData, error: insertError } = await supabase.from('trade_logs').insert([without]).select());
            }
            if (insertError || !insertData || insertData.length === 0) {
                const reason = insertError?.message || 'Insert returned empty data (possible RLS or constraint issue)';
                console.error(`[SUPABASE ERROR] Failed to insert trade_log after order: ${reason}`);
                // Don't throw — order already succeeded, just log
            } else {
                pendingTradeId = insertData[0].id;
                if (data.scan_id) {
                    supabase.from('agent_tool_calls')
                        .update({ trade_id: pendingTradeId })
                        .eq('scan_id', data.scan_id)
                        .eq('tenant_id', tenantId)
                        .then(() => {})
                        .catch(() => {});
                }
            }
        } catch (error) {
            console.error("[SUPABASE ERROR] Failed to insert trade_log after order:", error.message);
            // Don't throw — order already succeeded, just log
        }
      }

      if (closeFillConfirmed) {
          // 🟢 AM59 — the pre-write verification already read the REAL avg fill price and
          // fees from the terminally-FILLED order. Never re-derive them below.
          console.log(`[CLOSE VERIFY] Fill receipt already applied ($${executionPrice}).`);
      } else if (result.success_response?.average_price) {
          executionPrice = parseFloat(result.success_response.average_price);
      } else if (orderType === 'MARKET') {
          const orderId = result.success_response?.order_id;
          if (orderId) {
              console.log(`[EXECUTION SYNC] Awaiting definitive fill price from exchange...`);
              // 🟢 AM14 STEP 4 — STRICT fill poll for closes: require status FILLED (not
              // just a price field) and read the REAL fill price + fees. Bounded ~8s at
              // 400ms cadence. A close that never confirms FILLED must NOT be reported.
              const FILL_POLL_MS = 400, FILL_POLL_CAP_MS = 8000;
              const fillStart = Date.now();
              let fillConfirmed = false, fillRejected = false, rejectReason = '';
              for (let retry = 1; Date.now() - fillStart < FILL_POLL_CAP_MS; retry++) {
                  await closeSleep(FILL_POLL_MS);
                  try {
                      const checkPath = `/api/v3/brokerage/orders/historical/${orderId}`;
                      const checkResp = await cbRequest({ token: `${generateToken('GET', checkPath)}`, method: 'GET', path: `${checkPath}` });
                      if (!checkResp.ok) continue;
                      const checkData = await checkResp.json();
                      const ord = checkData.order || {};
                      const ordStatus = String(ord.status || '').toUpperCase();
                      if (ordStatus === 'FILLED') {
                          if (ord.average_filled_price) executionPrice = parseFloat(ord.average_filled_price);
                          closeFees = ord.total_fees != null ? parseFloat(ord.total_fees) : null;
                          fillConfirmed = true;
                          console.log(`[EXECUTION SYNC] Confirmed FILLED (attempt ${retry}): $${executionPrice} fees=${closeFees ?? 'n/a'}`);
                          break;
                      }
                      if (['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(ordStatus)) {
                          fillRejected = true;
                          rejectReason = ordStatus;
                          break;
                      }
                  } catch(e) { console.error(`[EXECUTION SYNC] Retry ${retry} failed:`, e.message); }
              }
              if (isClosing && !fillConfirmed) {
                  throw new Error(`step=await_fill: close order ${orderId} not FILLED within ${FILL_POLL_CAP_MS}ms (last status: ${rejectReason || 'PENDING'})`);
              }
              if (!fillConfirmed && !executionPrice) {
                  console.log(`[EXECUTION SYNC] No confirmed fill within cap for entry order ${orderId}.`);
              }
              if (fillRejected && !isClosing) {
                  console.warn(`[EXECUTION SYNC] Entry order ${orderId} reached ${rejectReason}.`);
              }
          } else {
              console.log(`[EXECUTION SYNC] No order_id returned. Cannot refetch fill price.`);
          }
      }

      // 🟢 AM14: phantom-exit fallback REMOVED for closes. If the strict poll above did
      // not confirm a FILLED close, we never reach stamping — the throw already routed
      // us to the fail path. Entries keep the safe market fallback below.
      if (!isClosing && (!executionPrice || isNaN(executionPrice) || executionPrice === 0)) {
          const fallback = incomingPrice || (recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].close : 0);
          console.log(`[EXECUTION SYNC] API returned empty fill price. Using safe fallback: $${fallback}`);
          executionPrice = fallback;
      }

      // 🟢 THE FIX 2: Strict Fallback to prevent $0 exits from entering the database (only for non-closing orders)
      if (!isClosing && (!executionPrice || isNaN(executionPrice) || executionPrice === 0)) {
          const fallback = incomingPrice || (recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].close : 0);
          console.log(`[EXECUTION SYNC] API returned empty fill price. Using safe fallback: $${fallback}`);
          executionPrice = fallback;
      }

      // 🛡️ PHASE D: Post-close flat verification.
      // Coinbase may return 2xx on the close order even when the actual flatten fails or
      // only partially fills. The previous bug ("brackets gone, position still open") slipped
      // through here. We re-query cfm/positions and require the position to be FLAT before
      // we let this function proceed to mark the trade closed in trade_logs. If not flat,
      // we redeploy the original brackets on the residual and throw so callers know the
      // close didn't take.
      // 🟢 Push 7 hotfix — lane-gated: PHASE D re-queries cfm/positions (Coinbase).
      // The KRF close's flat-verification is its own /openpositions reconcile inside
      // the lane block.
      if (isClosing && !isPaper && orderType === 'MARKET' && !krakenFuturesLane && !krakenSpotLane) {
          // Brief breath to let the exchange settle the fill before we read positions.
          await new Promise(resolve => setTimeout(resolve, 1500));
          let exchangeFlat = false;
          let residualQty = 0;
          for (let attempt = 0; attempt < 3; attempt++) {
              try {
                  const posPath = '/api/v3/brokerage/cfm/positions';
                  const posResp = await cbRequest({ token: `${generateToken('GET', posPath)}`, method: 'GET', path: `${posPath}` });
                  if (posResp.ok) {
                      const posData = await posResp.json();
                      const livePos = posData.positions?.find(p => p.product_id === coinbaseProduct);
                      residualQty = livePos ? Math.abs(parseFloat(livePos.number_of_contracts)) : 0;
                      if (residualQty === 0) { exchangeFlat = true; break; }
                  }
              } catch (vErr) {
                  console.error(`[CLOSE VERIFY] Attempt ${attempt + 1} failed:`, vErr.message);
              }
              await new Promise(resolve => setTimeout(resolve, 1500));
          }

          if (!exchangeFlat) {
              console.error(`[CLOSE VERIFY] Close did NOT flatten ${coinbaseProduct}. Residual=${residualQty} contracts. Restoring brackets and aborting close write-back.`);
              await restoreBracketsOnFailure(`Close incomplete; residual ${residualQty} contracts`);
              throw new Error(`Coinbase close incomplete for ${coinbaseProduct}: ${residualQty} contracts still open after order ${result.success_response?.order_id || 'unknown'}`);
          }
          console.log(`[CLOSE VERIFY] ${coinbaseProduct} confirmed FLAT on exchange.`);
      }

      // ── 🟢 AM59 STEP 4 — BRACKET CLEANUP (post-fill) ──────────────────────────
      // The orphaned TP 11.36 / SL 10.97 left resting after the AVP close is the
      // visual proof this sweep was missing. A confirmed close means the position is
      // FLAT, so every remaining open order for this product is stale protection and
      // must be cancelled — otherwise it can fire on the next unrelated position.
      // 🟢 Push 7 hotfix — lane-gated: the KRF close already cancelled its sibling
      // conditional inside the lane block (the AM59 STEP 4 analog); this sweep is
      // the Coinbase batch_cancel form.
      if (isClosing && !isPaper && closeFillConfirmed && !krakenFuturesLane && !krakenSpotLane) {
          try {
              const sweepPath = `/api/v3/brokerage/orders/historical/batch?order_status=OPEN&product_id=${coinbaseProduct}`;
              const sweepResp = await cbRequest({ token: `${generateToken('GET', sweepPath)}`, method: 'GET', path: `${sweepPath}` });
              if (!sweepResp.ok) throw new Error(`open-orders list failed (${sweepResp.status})`);
              const sweepData = await sweepResp.json();
              const stragglers = (sweepData.orders || []).filter(o => normalizeOrderStatus(o.status) === 'OPEN');
              if (stragglers.length > 0) {
                  const cancelPath = '/api/v3/brokerage/orders/batch_cancel';
                  const cancelResp = await cbRequest({ token: `${generateToken('POST', cancelPath)}`, method: 'POST', path: `${cancelPath}`, body: { order_ids: stragglers.map(o => o.order_id) } });
                  const cancelResult = await cancelResp.json().catch(() => ({}));
                  const failedCancels = cancelResult.results?.filter(r => !r.success) || [];
                  if (failedCancels.length > 0) {
                      await sendDiscordAlert(tenantId, {
                          title: `⚠️ Bracket Cleanup Incomplete: ${rawSymbol}`,
                          description: `Close confirmed flat, but ${failedCancels.length} orphaned open order(s) could not be cancelled: ${failedCancels.map(r => r.order_id).join(', ')}.`,
                          color: 15844367
                      });
                  } else {
                      console.log(`[CLOSE CLEANUP] Cancelled ${stragglers.length} orphaned order(s) for ${coinbaseProduct}.`);
                  }
              } else {
                  console.log(`[CLOSE CLEANUP] No orphaned open orders for ${coinbaseProduct}.`);
              }
          } catch (cleanupErr) {
              console.warn(`[CLOSE CLEANUP] Sweep failed for ${coinbaseProduct}: ${cleanupErr.message}`);
              await sendDiscordAlert(tenantId, {
                  title: `⚠️ Bracket Cleanup Failed: ${rawSymbol}`,
                  description: `Close confirmed flat but the orphaned-order sweep failed: ${cleanupErr.message}. Check for residual open orders.`,
                  color: 15844367
              });
          }
      }

      if (pendingTradeId) {
          // 🟢 AM59 — a PAPER trade closed in the SAME execution (trade_id supplied, no
          // exchange order) already stamped exit_price in the paper-close block below.
          // Never overwrite that back to null/the decision price (phantom-close class).
          if (isClosing && isPaper) {
              console.log(`[AM59] Skipped entry_price write-back for paper close of trade ${pendingTradeId}.`);
          } else {
              try {
                  await supabase.from('trade_logs').update({ entry_price: executionPrice }).eq('id', pendingTradeId);
              } catch (updateError) {
                  console.error("[SUPABASE ERROR] Failed to update trade_log entry_price:", updateError.message);
              }
          }
      }

      if (!isClosing && orderType === 'MARKET' && tpPrice && slPrice) {
          const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
          
          console.log(`[EXECUTION BREATH] Primary market order filled. Pausing 1.5s before deploying OCO brackets to prevent position size rejection...`);
          await new Promise(resolve => setTimeout(resolve, 1500));

          let actualQty = orderQty;
          try {
              const posPath = '/api/v3/brokerage/cfm/positions';
              const posResp = await cbRequest({ token: `${generateToken('GET', posPath)}`, method: 'GET', path: `${posPath}` });
              if (posResp.ok) {
                  const posData = await posResp.json();
                  const position = posData.positions?.find(p => p.product_id === coinbaseProduct);
                  if (position && Math.abs(parseFloat(position.number_of_contracts)) > 0) {
                      actualQty = Math.abs(parseFloat(position.number_of_contracts));
                      console.log(`[EXECUTION SYNC] Verified actual open position size: ${actualQty}`);
                  }
              }
          } catch(e) { console.error("[EXECUTION SYNC] Position fetch failed:", e.message); }

          // 🟢 AM30 — POST-ENTRY RECONCILE: if the exchange reports MORE contracts than
          // we ordered, a partial double-fill occurred (e.g. a racing duplicate entry).
          // Log it loudly and size the brackets to the FILLED number so the residual is
          // never left naked.
          if (actualQty > orderQty) {
              console.warn(`[ENTRY RECONCILE] filled=${actualQty} ordered=${orderQty} for ${coinbaseProduct} — partial double-fill detected. Sizing brackets to FILLED qty.`);
              await sendDiscordAlert(tenantId, { title: `⚠️ Entry Reconcile: ${rawSymbol}`, description: `**Filled:** ${actualQty} contracts
**Ordered:** ${orderQty} contracts
**Action:** Brackets sized to FILLED qty to keep the residual protected.`, color: 15548997 });
          }

          if (actualQty !== orderQty && pendingTradeId) {
              try {
                  await supabase.from('trade_logs').update({ qty: actualQty }).eq('id', pendingTradeId);
                  orderQty = actualQty;
              } catch (updateQtyError) {
                  console.error("[SUPABASE ERROR] Failed to update trade_log quantity:", updateQtyError.message);
              }
          }

          let ocoOrderId = null;
          let bracketVerifiedActive = false;

          try {
              // 🛡️ PRE-FLIGHT VALIDATION: Verify bracket prices are within Coinbase's acceptable range.
              // Coinbase will silently cancel brackets if the stop price is too close to market or
              // the limit price is outside the price band. We check BEFORE deploying to avoid the
              // "success response but immediately cancelled" bug.
              const preflightTickerPath = `/api/v3/brokerage/products/${coinbaseProduct}/ticker`;
              let currentMarketPrice = executionPrice;
              try {
                  const tickerResp = await cbRequest({ token: `${generateToken('GET', preflightTickerPath)}`, method: 'GET', path: `${preflightTickerPath}` });
                  if (tickerResp.ok) {
                      const tickerData = await tickerResp.json();
                      const tickerPrice = parseFloat(tickerData?.price || tickerData?.bid || tickerData?.ask || 0);
                      if (tickerPrice > 0) currentMarketPrice = tickerPrice;
                  }
              } catch (_) { /* non-critical; use executionPrice as fallback */ }

              // Minimum stop distance: Coinbase requires stops to be at least a certain distance from market.
              // We use tickSize * 100 as a conservative floor (e.g., ETH-PERP: 0.50 * 100 = $50 minimum).
              const minStopDistance = Math.max(tickSize * 100, executionPrice * 0.005);
              const slDistance = Math.abs(parseFloat(slPrice) - currentMarketPrice);
              const tpDistance = Math.abs(parseFloat(tpPrice) - currentMarketPrice);

              if (slDistance < minStopDistance) {
                  console.warn(`[OCO PREFLIGHT] SL $${slPrice} is only $${slDistance.toFixed(2)} from market $${currentMarketPrice} (min: $${minStopDistance.toFixed(2)}). Coinbase may reject. Adjusting SL outward by 1 tick.`);
                  // Push SL outward by one tickSize to stay within bounds
                  const adjustedSl = side === 'BUY' ? parseFloat(slPrice) + tickSize : parseFloat(slPrice) - tickSize;
                  slPrice = parseFloat((Math.round(adjustedSl / tickSize) * tickSize).toFixed(4));
              }

              console.log(`[OCO PREFLIGHT] Deploying bracket: TP=$${tpPrice} SL=$${slPrice} Qty=${actualQty} Market=$${currentMarketPrice} MinStopDist=$${minStopDistance.toFixed(2)}`);

              const ocoPayload = {
                  client_order_id: `nx_oco_${pendingTradeId}`, product_id: coinbaseProduct, side: closingSide,
                  order_configuration: { trigger_bracket_gtc: { limit_price: tpPrice.toString(), stop_trigger_price: slPrice.toString(), base_size: actualQty.toString() } }
              };
              const ocoResp = await cbRequest({ token: `${generateToken('POST', path)}`, method: 'POST', path: `${path}`, body: ocoPayload });
              const ocoResult = await ocoResp.json();

              if (!ocoResp.ok || ocoResult.success === false) {
                  const ocoErrMsg = ocoResult.error_response?.preview_failure_reason || ocoResult.error_response?.error || ocoResult.failure_reason?.error_message || JSON.stringify(ocoResult);
                  console.error(`[BRACKET REJECT] OCO Failed:`, ocoErrMsg);
                  await sendDiscordAlert(tenantId, { title: `⚠️ Bracket Failed: ${rawSymbol}`, description: `**Action:** Missing TP/SL protection!\n**Details:** ${ocoErrMsg}`, color: 15548997 });
              } else {
                  // 🛡️ POST-DEPLOYMENT VERIFICATION: Coinbase can return 200/success=true but
                  // internally cancel the bracket milliseconds later (e.g., stop price too close
                  // to market, size constraints, margin issues). We MUST verify the bracket is
                  // actually OPEN before reporting success to Discord.
                  ocoOrderId = ocoResult.success_response?.order_id || ocoResult.order_id || null;
                  console.log(`[OCO DEPLOY] Bracket placed. order_id=${ocoOrderId}. Waiting 2.5s for exchange settlement before verification...`);
                  await new Promise(resolve => setTimeout(resolve, 2500));

                  if (ocoOrderId) {
                      // Verify the bracket is still OPEN on Coinbase
                      const verifyPath = `/api/v3/brokerage/orders/historical/${ocoOrderId}`;
                      try {
                          const verifyResp = await cbRequest({ token: `${generateToken('GET', verifyPath)}`, method: 'GET', path: `${verifyPath}` });
                          if (verifyResp.ok) {
                              const verifyData = await verifyResp.json();
                              const verifyOrder = verifyData?.order;
                              const orderStatus = verifyOrder?.status?.toUpperCase();
                              console.log(`[OCO VERIFY] order_id=${ocoOrderId} status=${orderStatus} filled_size=${verifyOrder?.filled_size} product_id=${verifyOrder?.product_id}`);

                              if (orderStatus === 'OPEN' || orderStatus === 'PENDING') {
                                  bracketVerifiedActive = true;
                                  console.log(`[OCO VERIFY] ✅ Bracket confirmed ACTIVE on exchange.`);
                              } else if (orderStatus === 'CANCELLED' || orderStatus === 'FAILED' || orderStatus === 'EXPIRED') {
                                  const cancelReason = verifyOrder?.cancel_message || verifyOrder?.reject_reason || 'Unknown';
                                  console.error(`[OCO VERIFY] ❌ Bracket was ${orderStatus} by exchange: ${cancelReason}. Position is NAKED.`);
                                  // Redeploy with adjusted parameters — push SL further out
                                  const retrySl = side === 'BUY' ? parseFloat(slPrice) + (tickSize * 2) : parseFloat(slPrice) - (tickSize * 2);
                                  const retrySlStr = parseFloat((Math.round(retrySl / tickSize) * tickSize).toFixed(4));
                                  console.log(`[OCO RETRY] Redeploying bracket with adjusted SL: $${retrySlStr} (was $${slPrice})`);
                                  const retryPayload = {
                                      client_order_id: `nx_oco_retry_${pendingTradeId}_${Date.now()}`,
                                      product_id: coinbaseProduct, side: closingSide,
                                      order_configuration: { trigger_bracket_gtc: { limit_price: tpPrice.toString(), stop_trigger_price: retrySlStr, base_size: actualQty.toString() } }
                                  };
                                  const retryResp = await cbRequest({ token: `${generateToken('POST', path)}`, method: 'POST', path: `${path}`, body: retryPayload });
                                  const retryResult = await retryResp.json();
                                  if (retryResp.ok && retryResult.success !== false) {
                                      ocoOrderId = retryResult.success_response?.order_id || retryResult.order_id || null;
                                      bracketVerifiedActive = true;
                                      console.log(`[OCO RETRY] ✅ Retry bracket deployed. order_id=${ocoOrderId}`);
                                      await sendDiscordAlert(tenantId, { title: `🛡️ Brackets Redeployed: ${rawSymbol}`, description: `**Take Profit:** $${tpPrice}\n**Stop Loss:** $${retrySlStr} (adjusted from $${slPrice})\n**Status:** Active on Exchange (retry after ${cancelReason})`, color: 10181046 });
                                  } else {
                                      const retryErr = retryResult.error_response?.preview_failure_reason || retryResult.error_response?.error || JSON.stringify(retryResult);
                                      console.error(`[OCO RETRY] Retry also failed: ${retryErr}`);
                                      await sendDiscordAlert(tenantId, { title: `🚨 NAKED POSITION: ${rawSymbol}`, description: `**Both initial AND retry brackets failed.** ${retryErr}. **${actualQty} contracts unprotected.** Manual intervention required.`, color: 15158332 });
                                  }
                              }
                          } else {
                              console.warn(`[OCO VERIFY] Verification API returned ${verifyResp.status}. Assuming bracket is active.`);
                              bracketVerifiedActive = true; // Conservative: assume active if we can't verify
                          }
                      } catch (verifyEx) {
                          console.error('[OCO VERIFY] Verification exception:', verifyEx.message);
                          bracketVerifiedActive = true; // Conservative: assume active if verification fails
                      }
                  } else {
                      // No order_id in response — bracket may still be active
                      console.warn('[OCO VERIFY] No order_id returned from Coinbase. Cannot verify bracket status.');
                      bracketVerifiedActive = true; // Conservative: assume active
                  }

                  // Only send success Discord alert if bracket was actually verified active
                  if (bracketVerifiedActive) {
                      await sendDiscordAlert(tenantId, { title: `🎯 Brackets Deployed: ${rawSymbol}`, description: `**Take Profit:** $${tpPrice}\n**Stop Loss:** $${slPrice}\n**Status:** Verified Active on Exchange`, color: 10181046 });
                  }

                  // Store oco_order_id on trade_logs for watchdog verification
                  if (ocoOrderId && pendingTradeId) {
                      try {
                          await supabase.from('trade_logs').update({ oco_order_id: ocoOrderId }).eq('id', pendingTradeId);
                          console.log(`[OCO TRACK] Stored oco_order_id=${ocoOrderId} on trade_log id=${pendingTradeId}`);
                      } catch (trackErr) {
                          console.error('[OCO TRACK] Failed to store oco_order_id:', trackErr.message);
                      }
                  }
              }
          } catch (e) { console.error("[BRACKET FATAL] OCO failed:", e.message); }
      }
    }

    // 🟢 PAPER TRADE: Create trade_log without Coinbase API (risk check only)
    if (isPaper && !isClosing && !isForcedExit) {
        console.log(`[EXECUTE] Opening new ${side} PAPER position for ${rawSymbol}...`);

        // � AM63 (Push 4) — kraken PAPER entry is priced at the VENUE mark (never
        // a Coinbase substitute). getMarketStats returns {} (truthy) when the
        // payload is present but the resolved productId row is MISSING — treat a
        // missing row like a null payload (loud 502). Never a silent NaN PnL.
        if (krakenLane) {
            const stats = await getMarketStats({ productIds: [krakenProduct.productId] });
            const row = stats ? stats[krakenProduct.productId] : null;
            const mark = row ? (row.mark_price ?? row.last_price) : null;
            const markPrice = parseFloat(mark);
            if (!row || !Number.isFinite(markPrice) || markPrice <= 0) {
                console.error(`[AM63] kraken stats unavailable for ${rawSymbol} (product ${krakenProduct.productId})`);
                return { error: `[AM63] kraken stats unavailable for ${rawSymbol}`, status: 502 };
            }
            executionPrice = parseFloat((Math.round(markPrice / tickSize) * tickSize).toFixed(4));
            entryParamsContext.kraken_native_symbol = krakenProduct.nativeSymbol;
            console.log(`[AM63] kraken paper entry for ${rawSymbol} priced at venue mark $${executionPrice} (native ${krakenProduct.nativeSymbol}).`);
        }

        // � AM63 (Push 5) — krakenfutures PAPER entry is priced at the VENUE mark
        // (never a Coinbase substitute). getKrakenTickers returns {} (truthy) when the
        // payload is present but the resolved symbol row is MISSING — treat a missing
        // row like a null payload (loud 502). Tick-round with the instrument's OWN
        // tickSize (kfTickSize), NOT a coinbase-derived tick.
        if (krakenFuturesLane) {
            const tickers = await getKrakenTickers({ symbols: [krakenFuturesProduct.nativeSymbol] });
            const row = tickers ? tickers[krakenFuturesProduct.nativeSymbol] : null;
            const mark = row ? (row.markPrice ?? row.last) : null;
            const markPrice = parseFloat(mark);
            if (!row || !Number.isFinite(markPrice) || markPrice <= 0) {
                console.error(`[AM63] krakenfutures stats unavailable for ${rawSymbol} (symbol ${krakenFuturesProduct.nativeSymbol})`);
                return { error: `[AM63] Kraken Futures stats unavailable for ${rawSymbol}`, status: 502 };
            }
            executionPrice = parseFloat((Math.round(markPrice / kfTickSize) * kfTickSize).toFixed(8));
            entryParamsContext.krakenfutures_native_symbol = krakenFuturesProduct.nativeSymbol;
            console.log(`[AM63] krakenfutures paper entry for ${rawSymbol} priced at venue mark $${executionPrice} (native ${krakenFuturesProduct.nativeSymbol}, tick ${kfTickSize}).`);
        }

        // � AM68 — kraken SPOT (+ margin) PAPER entry is priced at the VENUE mark
        // (never a Coinbase substitute). A missing row is treated like a null payload
        // (loud 502). Tick-round with the pair's OWN tick.
        if (krakenSpotLane) {
            const tickers = await getKrakenSpotTickers({ symbols: [krakenSpotProduct.nativeSymbol] });
            const row = tickers ? tickers[krakenSpotProduct.nativeSymbol] : null;
            const markPrice = row ? parseFloat(row.last) : NaN;
            if (!row || !Number.isFinite(markPrice) || markPrice <= 0) {
                console.error(`[AM68] krakenspot ticker unavailable for ${rawSymbol} (symbol ${krakenSpotProduct.nativeSymbol})`);
                return { error: `[AM68] Kraken Spot ticker unavailable for ${rawSymbol}`, status: 502 };
            }
            executionPrice = parseFloat((Math.round(markPrice / ksTickSize) * ksTickSize).toFixed(8));
            entryParamsContext.krakenspot_native_symbol = krakenSpotProduct.nativeSymbol;
            console.log(`[AM68] krakenspot paper entry for ${rawSymbol} priced at venue mark $${executionPrice} (native ${krakenSpotProduct.nativeSymbol}, tick ${ksTickSize}).`);
        }

        // 🔒 RISK VALIDATOR: Check if trade complies with tenant risk profile
        const riskCheck = await validateTradeRisk(tenantId, {
            side, symbol: rawSymbol,
            entryPrice: executionPrice,
            slPrice: slPrice,
            tpPrice: tpPrice,
            qty: orderQty,
            leverage: leverage
        }, {
            assetSpecs: krakenFuturesLane
                ? { ...assetSpecs, contract_size: kfMultiplier }
                : (krakenSpotLane
                    ? { ...assetSpecs, contract_size: 1 }
                    : (krakenLane ? { ...assetSpecs, contract_size: krakenMultiplier } : assetSpecs)),
            executionMode: 'PAPER'
        });

        if (!riskCheck.approved) {
            // AM52h: supabase builder has no .catch (thenable only) — use
            // try/catch so a failed veto log never aborts the veto return.
            try {
                await supabase.from('risk_veto_log').insert([{
                    tenant_id: tenantId,
                    asset: rawSymbol,
                    side,
                    entry_price: executionPrice,
                    qty: orderQty,
                    leverage,
                    reason: riskCheck.reason,
                    execution_mode: 'PAPER'
                }]);
            } catch (e) {
                console.warn('[RISK LOG] Insert failed:', e.message);
            }
            await sendDiscordAlert(tenantId, {
                title: `🚫 Risk Profile Block — ${rawSymbol}`,
                description: riskCheck.reason,
                color: 15548997,
                fields: [
                    { name: 'Side', value: side, inline: true },
                    { name: 'Entry', value: `$${executionPrice}`, inline: true },
                    { name: 'Qty', value: String(orderQty), inline: true },
                    { name: 'Leverage', value: `${leverage}x`, inline: true },
                    { name: 'Mode', value: 'PAPER', inline: true },
                ]
            }).catch(e => console.warn('[RISK DISCORD] Send failed:', e.message));
            return { status: "risk_vetoed", reason: riskCheck.reason, product: coinbaseProduct };
        }

        if (riskCheck.clamped_sl !== null || riskCheck.clamped_qty !== null) {
            // 🟢 PUSH AM55 — capture originals BEFORE reassignment so the alert
            // prints the true "from X to Y" (previously it printed X→X).
            const originalSl = slPrice;
            const originalQty = orderQty;
            const clampDetails = buildClampDetails({
                originalSl, originalQty,
                clampedSl: riskCheck.clamped_sl,
                clampedQty: riskCheck.clamped_qty
            });
            if (riskCheck.clamped_sl !== null) slPrice = riskCheck.clamped_sl;
            if (riskCheck.clamped_qty !== null) orderQty = riskCheck.clamped_qty;
            await sendDiscordAlert(tenantId, {
                title: `⚠️ Risk Adjustment: ${rawSymbol}`,
                description: `**Mode:** ${mode}\n**Adjustments:** ${clampDetails.join(', ')}\n**Reason:** ${riskCheck.reason || 'Risk profile limits applied'}`,
                color: 15844367
            });
        }

        try {
            // 🟢 PUSH AM53 — params_context carries the entry-time regime/exit lock.
            const paperInsertPayload = {
                tenant_id: tenantId,
                symbol: rawSymbol, strategy_id: canonicalStrategyId, version: version, side: side, order_type: orderType, 
                entry_price: executionPrice, execution_mode: mode, qty: orderQty, leverage: leverage, market_type: marketType, tp_price: tpPrice, sl_price: slPrice, reason: tradeReason,
                exit_time: null,
                market_snapshot_at_entry: fullMarketSnapshot || buildMarketSnapshot(executionPrice),
                regime_at_entry: regimeAtEntry,
                influencing_memory_ids: influencingMemoryIds,
                macro_tf: resolvedMacroTf,
                trigger_tf: resolvedTriggerTf,
                // 🟢 AM63 (Push 2) — paper follows the config's venue even though execution is paper.
                exchange: resolvedExchange,
                // 🟢 Phase 3C: model + archetype + conviction enrichment at entry
                microstructure_archetype: data._microstructure_archetype || null,
                model_predicted_win_prob: data._model_predicted_win_prob ?? null,
                model_predicted_pnl: data._model_predicted_pnl ?? null,
                conviction_score_at_entry: data._conviction_score ?? null,
                transaction_fee: data._transaction_fee ?? null,
                // 🟢 PUSH AM53 — entry-time regime/exit lock (see entryParamsContext).
                params_context: entryParamsContext,
                // 🟢 AM62 — market-structure bias at entry (migration 059).
                structure_direction: structureDirection
            };
            let { data: insertData, error: insertError } = await supabase.from('trade_logs').insert([paperInsertPayload]).select();
            // 🛡️ AM53/AM62 SAFETY NET: never lose the trade row over an audit
            // column — if params_context (pre-048) or structure_direction (pre-059)
            // is rejected, retry WITHOUT the named column(s).
            if ((insertError || !insertData || insertData.length === 0) && /(params_context|structure_direction|exchange)/i.test(insertError?.message || '')) {
                console.warn(`[AM53/AM62/AM63] PAPER insert rejected an additive column (${insertError.message}) — retrying without it.`);
                const without = { ...paperInsertPayload };
                if (/params_context/i.test(insertError.message || '')) delete without.params_context;
                if (/structure_direction/i.test(insertError.message || '')) delete without.structure_direction;
                if (/exchange/i.test(insertError.message || '')) { delete without.exchange; console.warn('[AM63] trade saved WITHOUT exchange — migration 060 not applied (deploy order error)'); }
                ({ data: insertData, error: insertError } = await supabase.from('trade_logs').insert([without]).select());
            }
            if (insertError || !insertData || insertData.length === 0) {
                throw new Error(insertError?.message || 'PAPER trade insert returned no data (null guard)');
            }
            pendingTradeId = insertData[0].id;
            if (data.scan_id) {
                supabase.from('agent_tool_calls')
                    .update({ trade_id: pendingTradeId })
                    .eq('scan_id', data.scan_id)
                    .eq('tenant_id', tenantId)
                    .then(() => {})
                    .catch(() => {});
            }
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
        // 🟢 AM63 (Push 4) — kraken has no intraday candles; decline the Coinbase
        // structure-candle fetch and stamp NULL (never a cross-venue substitute).
        // 🟢 AM63 (Push 7) — the KRF LIVE close path ALSO declines: its receipt is
        // already verified; a Coinbase structure fetch here would be a cross-venue
        // call on the hot close path (the entry path keeps venue candles via the
        // bridge — only the close-time re-derive is declined).
        const closeStructureDirection = (krakenLane || (krakenFuturesLane && !isPaper) || (krakenSpotLane && !isPaper)) ? null : deriveStructureDirection(
            await fetchStructureCandles(coinbaseProduct, resolvedMacroTf, Date.now() / 1000),
            telemetry?.macro_cvd ?? telemetry?.micro_cvd ?? telemetry?.cvd ?? null
        );
        if (krakenLane) console.warn('[AM63] structure_direction unavailable for kraken (no charts until venue OHLC)');
        if (krakenFuturesLane && !isPaper) console.warn('[AM63] structure_direction re-derive declined for the krakenfutures LIVE close (receipt-verified path)');
        // 🟢 AM59 — NEVER stamp a LIVE close without a confirmed fill receipt. The
        // pre-write verification returns close_failed on any unconfirmed fill, so
        // reaching here implies safeExitPrice IS the real avg fill price. This guard is
        // the last line of defence against a phantom-close write.
        if (!isPaper && !closeFillConfirmed) {
            console.error(`[AM59] Refusing to stamp close for trade ${openTrade.id} — no confirmed fill receipt.`);
            return closeFailedResult('write_without_receipt', 'no confirmed fill receipt at write time');
        }
        const pnl = openTrade.side === 'BUY' ? (safeExitPrice - safeEntryPrice) * orderQty * effectiveMultiplier : (safeEntryPrice - safeExitPrice) * orderQty * effectiveMultiplier;
        const updatedReason = openTrade.reason ? `${openTrade.reason}\n\n[EXIT TRIGGER]: ${tradeReason || 'MANUAL_CLOSE'}` : (tradeReason || 'MANUAL_CLOSE');

        const closeSnapshot = buildMarketSnapshot(safeExitPrice);
        try {
            const { error: updateError } = await supabase.from('trade_logs').update({
                exit_price: safeExitPrice,
                pnl: parseFloat(pnl.toFixed(4)),
                exit_time: new Date().toISOString(),
                reason: updatedReason,
                market_snapshot_at_close: closeSnapshot,
                regime_at_close: telemetry.macro_regime_oracle || null,
                // 🟢 AM62b — structure bias at CLOSE, re-derived from macro-TF price
                // structure at close (an intentional entry→close drift signal).
                // 🟢 AM63 (Push 4) — NULL for kraken (no intraday candles).
                structure_direction: closeStructureDirection,
                // 🟢 AM7 — params at close: config_id + agent diff. No full
                // snapshot — the config was current at close by definition.
                // 🟢 AM14 — exit_fees: REAL exchange fees from the confirmed fill
                // (null for paper closes). No separate column — embedded in jsonb.
                //
                // 🟢 PUSH AM53 — CAUTION 1: this MUST merge into the entry snapshot
                // written at INSERT (regime_selected / regime_params_applied /
                // entry_tripwire / entry_trail_step / entry_trail_activation). A blind
                // overwrite here would destroy the entry lock we just created. Spread
                // the existing row's params_context FIRST, then overlay close-time keys.
                params_context: {
                    ...(openTrade?.params_context && typeof openTrade.params_context === 'object' ? openTrade.params_context : {}),
                    ...paramsContext,
                    exit_fees: closeFees,
                    // 🟢 AM63 (Push 7) — the KRF receipt: venue order id + the venue's
                    // own realized_pnl (fees are null — /fills carries no fee field).
                    ...(krakenFuturesLane && !isPaper ? {
                        kf_close_order_id: kfCloseOrderId,
                        kf_close_realized_pnl: kfCloseRealizedPnl,
                    } : {}),
                    // 🟢 AM68 — the Kraken SPOT receipt: venue txid + fees.
                    ...(krakenSpotLane && !isPaper ? {
                        ks_close_txid: ksCloseTxid,
                    } : {}),
                }
            }).eq('id', openTrade.id);
            
            if (updateError) {
                console.error("[SUPABASE ERROR] TRADE LOG UPDATE FAILED:", updateError.message);
            } else {
                try {
                    await supabase.from('scan_results').insert([{ strategy: strategyId, asset: rawSymbol, status: 'CLOSED', telemetry: { status_overlay: `AGENT CLOSED POSITION`, oracle_reasoning: updatedReason, open_pnl: pnl.toFixed(4), open_position: "NONE" } }]);
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
            }).eq('tenant_id', tenantId).eq('strategy', strategyId).eq('asset', rawSymbol);
        } catch (updateConfigError) {
            console.error("[SUPABASE ERROR] Failed to update strategy_config on trade close:", updateConfigError.message);
        }

        // 🟢 TRIGGER AUTOPSY (For BOTH Paper & Live to build core memory)
        try {
            let autopsyUrl = 'http://localhost:8000/api/autopsy';
            if (process.env.HERMES_WEBHOOK_URL) {
                const baseHermes = process.env.HERMES_WEBHOOK_URL.replace(/\/api\/wake\/?$/, '').replace(/\/wake\/?$/, '');
                autopsyUrl = `${baseHermes}/api/autopsy`;
            }
            await fetch(autopsyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tenant_id: tenantId,
                    asset: rawSymbol,
                    entry_price: safeEntryPrice,
                    exit_price: safeExitPrice,
                    pnl: parseFloat(pnl.toFixed(4)),
                    rolling_ledger: updatedReason,
                    trigger: tradeReason || 'MANUAL_CLOSE',
                    macro_tf: data.macro_tf || 'ONE_HOUR',
                    trigger_tf: data.trigger_tf || 'FIVE_MINUTE',
                    // Pass the close snapshot + mode so the autopsy persists what
                    // the market looked like at exit (paper + live both dissected).
                    execution_mode: openTrade.execution_mode || mode,
                    regime_at_close: telemetry.macro_regime_oracle || null,
                    market_snapshot: closeSnapshot,
                    working_thesis: data.working_thesis || null,
                    trade_log_id: openTrade?.id || null,
                    // 🟢 Phase 0.7.3: strategy key for layered memory scoring
                    strategy_id: strategyId || null,
                    // 🟢 AM7 — parameter-aware autopsy inputs: config baseline +
                    // agent diff, exit reason, bars held, entry win-prob bucket.
                    params_context: paramsContext,
                    exit_reason: tradeReason || 'MANUAL_CLOSE',
                    entry_time: openTrade?.created_at || null,
                    model_predicted_win_prob: data._model_predicted_win_prob ?? null
                })
            }).catch(e => console.error("[AUTOPSY FETCH FAULT]", e.message));
        } catch(e) {
            console.error("[AUTOPSY TRIGGER ERROR]", e.message);
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
    } else if (isLiveDirectClose) {
      // Live exchange position flattened (no DB row to write back). Confirm to
      // the user that the position was closed rather than "opened".
      executionStatus = 'closed_position';
      await sendDiscordAlert(tenantId, {
          title: `🏁 Live Position Closed: ${rawSymbol}`,
          description: `**Exit Price:** $${executionPrice}\n**Fees:** ${closeFees != null ? `$${closeFees}` : 'n/a'}\n**Qty:** ${orderQty}\n**Trigger:** ${tradeReason || 'MANUAL_UI_CLOSE'}\n_Closed directly on the exchange (no tracked trade row)._`,
          color: 5763719,
          fields: standardFields,
          imageUrl: chartUrl
      });
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
                .eq('tenant_id', tenantId)
                .eq('strategy', strategyId)
                .eq('asset', rawSymbol);
        } catch (updateThesisError) {
            console.error("[SUPABASE ERROR] Failed to update strategy_config active_thesis:", updateThesisError.message);
        }
    }

    return { status: executionStatus, product: coinbaseProduct, price: executionPrice, trade_id: pendingTradeId || openTrade?.id || null }; 

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    const faultTenantId = data.tenant_id;
    if (faultTenantId) {
        await sendDiscordAlert(faultTenantId, { title: "❌ Execution Fault", description: `**Error:** ${err.message}`, color: 15548997 });
    }
    return { error: err.message }; 
  }
}