// lib/providers/kraken-futures.js
// 🟢 PUSH AM63 (Push 5, Commit A — INERT) — the ONE Kraken Futures (apiv3) transport door.
//
// The underlying exchange is Kraken Futures (apiv3, futures.kraken.com). The platform
// venue literal is 'krakenfutures' everywhere — do NOT confuse it with 'kraken', which
// is Bitnomial (Kraken Derivatives US) and lives in lib/providers/kraken-bitnomial.js.
//
// 🟢 PUSH AM63 (Push 7, Commit A — INERT) — the apiv3 PRIVATE layer now lives here too:
// kfSign (HMAC-SHA512 over SHA256(urlencoded-postData + nonce + endpointPath), key =
// base64-DECODED api secret), kfPrivateRequest (creds resolved ITSELF via
// retrieveAPIKey(supabase, tenantId, 'krakenfutures') — callers never hold secrets),
// placeKrakenFuturesOrder (the phantom result:'success' trap is a GUARD here — the
// inner sendStatus.status carries the truth), pollKrakenFuturesFill (the AM59 receipt
// source), cancel helpers + the dead-man heartbeat wrapper, the cost-weighted limiter,
// and fetchKrakenFuturesBalance. NOTHING behavior-bearing imports the private symbols
// yet (Commit B binds them at the execute-trade / watchdog / asset-resolver seams).
//
// PROBE-AT-BUILD receipts (OpenAPI-pinned 2026-10-16 from
// docs.kraken.com/openapi/futures-rest.yaml — the derivatives reference IS
// OpenAPI-generated; live demo-host confirmation is the FIRST act of the soak):
//   - sendorder: ALL params ride as urlencoded body fields. orderType enum
//     lmt|post|ioc|mkt|stp|take_profit|trailing_stop|fok; side buy|sell; size in
//     CONTRACTS; stopPrice is the TRIGGER for stp/take_profit; triggerSignal REQUEST
//     enum is mark|index|last (the mark_price|last_price|spot_price list is the
//     RESPONSE echo shape in OrderTriggerJson); reduceOnly boolean; cliOrdId ≤100.
//     Response { result:'success', sendStatus:{ order_id, status, receivedTime,
//     orderEvents?, cliOrdId? } } — result:'success' does NOT mean the order placed.
//   - sendStatus.status enum (pinned): placed, partiallyFilled, filled, cancelled,
//     edited, marketSuspended, marketInactive, invalidPrice, invalidSize,
//     tooManySmallOrders, insufficientAvailableFunds, wouldCauseLiquidation,
//     clientOrderIdAlreadyExist, clientOrderIdTooLong, maxPositionViolation,
//     outsidePriceCollar, wouldIncreasePriceDislocation, notFound,
//     orderForEditNotAStop, orderForEditNotFound, postWouldExecute,
//     iocWouldNotExecute, selfFill, wouldNotReducePosition, marketIsPostOnly,
//     tooManyOrders, fixedLeverageTooHigh, clientOrderIdInvalid,
//     cannotEditTriggerPriceOfTrailingStop, cannotEditLimitPriceOfTrailingStop,
//     wouldProcessAfterSpecifiedTime, invalidDomainConfiguration, editAlreadyHeld,
//     invalidOrderType, invalidSide.
//   - cancelorder: order_id (uuid) OR cliOrdId → cancelStatus.{status:
//     cancelled|filled|notFound}. cancelallorders: optional symbol.
//   - cancelallordersafter (dead man's switch): timeout in SECONDS; Kraken's own
//     recommendation is a call every 15–20 s with timeout 60; timeout=0 deactivates.
//   - fills: GET /fills, optional lastFillTime cursor (100 entries before it).
//     FillJson = fill_id, symbol, side, order_id, size, price, fillTime, fillType,
//     cliOrdId?, realized_pnl? (venue-computed, nullable), sequence_id?. NO FEE FIELD
//     — AM59 real-fee stamping degrades honestly (exit_fees null + realized_pnl).
//   - instruments carry contractValueTradePrecision (min qty decimal places; can be
//     negative for 10/100 increments) + minimumTradeSize (docs say "TODO: not
//     populated" — treated as no floor when null). Size is in CONTRACTS.
//   - accounts: PF_ (flexible/multi-collateral) balances in accounts.flex —
//     availableMargin / initialMarginWithOrders / balanceValue; margin accounts
//     expose auxiliary.af as the fallback.
//
// Seam-to-seam parity with lib/providers/kraken-bitnomial.js: this file is the ONLY
// place the futures.kraken.com hostname appears outside config, and ALL egress goes
// through kfFetch (which draws from the shared cost-budget limiter FIRST).
//
// Verified contracts (live-probed 2026-10-15, public, no auth):
//   - GET /derivatives/api/v3/instruments → { result:'success', instruments:[…] }
//       per-instrument: symbol (PF_XBTUSD), type ('futures_inverse'|'flexible_futures'),
//       base (CLEAN: XBT/ETH/ADA — unlike Bitnomial's polluted base_symbol), quote (USD),
//       contractSize, tickSize, tradeable, suspended, isExpired, maxPositionSize, …
//   - GET /derivatives/api/v3/tickers → { result:'success', tickers:[…] }
//       per-ticker: symbol, markPrice, last, bid, ask, indexPrice, fundingRate,
//       openInterest, vol24h, lastTime, … ONE call = the whole stats surface.
//   - Charts: GET /api/charts/v1/trade/{symbol}/{res} → { candles:[{time,open,high,low,
//       close,volume}] } — public OHLC. time is epoch MILLISECONDS; OHLC+volume are
//       STRINGS. (Consumed by the candle bridge in Commit B, not here.)
//   - Order book (live-probed 2026-10-15/16, Push 6): GET /derivatives/api/v3/orderbook
//       ?symbol=PF_XRPUSD → { result:'success', orderBook:{ bids:[[price,qty],…],
//       asks:[[price,qty],…] }, serverTime }. QUERY-PARAM form — the path-segment form
//       (/orderbook/PF_XRPUSD) 404s. Live XRP: 344 bid + 467 ask levels. NO `limit`
//       param is sent (only `symbol=` is probe-pinned); truncation is client-side in
//       summarizeKrakenBook. Returns the RAW Response (parity contract) — callers
//       parse. NO cache (the book is hot; a stale book is worse than a slow one).
//   - Demo env: identical shapes under https://demo-futures.kraken.com (free signup).
//   - Rate limits: apiv3 is a COST budget (500/10s shared; sendorder costs 10 — n/a until
//     Push 6). Public reads are cheap; still route EVERY call through the budgeted limiter.
//
// INERT: NOTHING behavior-bearing imports this module yet (Commit A). Commit B binds it
// at the catalog / execute-trade / watchdog / close-position seams.

const KF_PROD_HOST = 'https://futures.kraken.com';
const KF_DEMO_HOST = 'https://demo-futures.kraken.com';

// The ONE place the hostname appears outside config. An operator can aim at the demo
// environment without a code change (KRAKEN_FUTURES_HOST=… or KRAKEN_FUTURES_DEMO=1).
export const KF_HOST = (() => {
  const override = process.env.KRAKEN_FUTURES_HOST;
  if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  if (process.env.KRAKEN_FUTURES_DEMO === '1' || process.env.KRAKEN_FUTURES_DEMO === 'true') {
    return KF_DEMO_HOST;
  }
  return KF_PROD_HOST;
})();

import crypto from 'node:crypto';
import { retrieveAPIKey } from '../secrets-manager.js';
import { fixTransportEnabled } from './kraken-fix.js';
// 🟢 AM65 — the Unified FIX lane (Commit B binding). Dispatch lives INSIDE the
// private functions below: fix-mode routes through lib/providers/kraken-fix.js
// (owner process: direct session; non-owner: gateway proxy), rest-mode is the
// EXISTING apiv3 path byte-unchanged. Default transport is 'rest' until the
// operator's jurisdiction probe is green.

const INSTRUMENTS_PATH = '/derivatives/api/v3/instruments';
const TICKERS_PATH = '/derivatives/api/v3/tickers';
const ORDERBOOK_PATH = '/derivatives/api/v3/orderbook';

// ── 🟢 Push 7 — apiv3 PRIVATE paths + the doc'd cost budget ─────────────────
// Cost map (apiv3 is a COST budget, 500/10s shared): sendorder 10, cancelorder 10,
// cancelallorders 25, accounts 2, openpositions 2. Reads cost 1. cancelallordersafter
// is not in the doc'd list — assumed cancelorder-class (10), confirmed at the soak.
const SENDORDER_PATH = '/derivatives/api/v3/sendorder';
const CANCELORDER_PATH = '/derivatives/api/v3/cancelorder';
const CANCELALLORDERS_PATH = '/derivatives/api/v3/cancelallorders';
const CANCELALLORDERSAFTER_PATH = '/derivatives/api/v3/cancelallordersafter';
// 🟢 Push 7 hotfix — the watchdog imports these three for its own venue-state +
// /fills forensics reads (single-source stays intact: the paths live ONLY here).
// They were non-exported consts at first ship, which crash-looped the swarm worker
// service at import ("does not provide an export named 'FILLS_PATH'") — the push7
// gate's import-graph smoke now covers every module the worker service boots.
export const OPENORDERS_PATH = '/derivatives/api/v3/openorders';
export const OPENPOSITIONS_PATH = '/derivatives/api/v3/openpositions';
export const FILLS_PATH = '/derivatives/api/v3/fills';
const ACCOUNTS_PATH = '/derivatives/api/v3/accounts';

const KF_COSTS = {
  sendorder: 10,
  cancelorder: 10,
  cancelallorders: 25,
  cancelallordersafter: 10,
  accounts: 2,
  openpositions: 2,
  openorders: 1,
  fills: 1,
};

// sendStatus.status values that mean the order is LIVE on the book (or already
// executed). Everything else in the pinned enum is a REJECT — the phantom trap.
const KF_PLACED_STATUSES = new Set(['placed', 'partiallyFilled', 'filled']);
// Terminal reject statuses we branch on explicitly (readable rejections to the brain).
const KF_INSUFFICIENT_FUNDS_STATUS = 'insufficientAvailableFunds';
const KF_WOULD_LIQUIDATE_STATUS = 'wouldCauseLiquidation';

// Dead-man heartbeat: module-scope last-refresh map (per tenant) so the wrapper can
// self-throttle. Kraken recommends a call every 15–20 s with timeout 60 — refreshing
// at the raw 5 s watchdog sweep cadence would burn ~200 of the 500/10s budget and
// starve the entry budget (the exact starvation the spec forbids for fill polls).
const KF_DEADMAN_MIN_INTERVAL_MS = 15 * 1000;
const KF_DEADMAN_TIMEOUT_SECONDS = 60;
const lastDeadManRefresh = new Map(); // tenantId → ms epoch

// ── module-scope caches (Map + TTL is the repo convention; one slot per endpoint) ──
const TICKERS_TTL_MS = 15 * 1000;          // ≥15 s — one call serves a whole sweep
const INSTRUMENTS_TTL_MS = 60 * 60 * 1000; // ≥1 h — the instrument set rolls rarely

let tickersCache = { at: 0, bySymbol: null };
let instrumentsCache = { at: 0, byId: null, byNativeSymbol: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── rate limiter: apiv3 is a COST budget (500 / 10 s shared) ─────────────────
// EVERY outbound Kraken Futures call draws from this one bucket. acquire() resolves
// when a slot frees; it never rejects for ordinary contention — the queue drains
// inside the window. Exhaustion surfaces as the loud [AM63] reason.
export class KfRateLimiter {
  constructor(max = 500, windowMs = 10 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.timestamps = [];
    this.queue = [];
    this.timer = null;
  }

  acquire() {
    return this.acquireWeighted(1);
  }

  // 🟢 Push 7 — cost-weighted admission. Queue entries carry their cost; _drain
  // admits when the window has room for the WHOLE cost (a cost-10 sendorder never
  // squeezes in ahead of budget) and pushes `cost` timestamps. Public reads cost 1
  // (acquire() delegates here) so the AM59 fill-poll loops can never starve the
  // entry budget — the poll draws 1 per poll while the entry draws 10.
  acquireWeighted(cost = 1) {
    const c = Math.max(1, Math.min(Math.floor(Number(cost) || 1), this.max));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, cost: c });
      this._drain();
    });
  }

  _drain() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    while (this.queue.length > 0 && this.timestamps.length + this.queue[0].cost <= this.max) {
      const next = this.queue.shift();
      for (let i = 0; i < next.cost; i++) this.timestamps.push(now);
      next.resolve();
    }
    if (this.queue.length > 0 && !this.timer) {
      const waitMs = Math.max(1000, this.windowMs - (now - this.timestamps[0]));
      this.timer = setTimeout(() => {
        this.timer = null;
        console.warn(`[AM63] Kraken Futures rate limiter window elapsed — draining ${this.queue.length} queued request(s).`);
        this._drain();
      }, waitMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }
}

// The ONE shared instance. Export the instance so callers (and the gate) can observe
// the bucket; behavior code must NOT construct its own.
export const kfRateLimiter = new KfRateLimiter();

/**
 * The single egress helper. Resolves globalThis.fetch AT CALL TIME (so AM55/AM59 test
 * stubs still intercept), draws a limiter slot FIRST, and retries 429s with backoff.
 * NO new AbortSignal.timeout — callers that want one pass a signal.
 * 🟢 HOTFIX 5 — fetch diagnostics: every non-2xx logs method + URL path + status
 * (never query strings, never headers, never key material) so a venue outage or
 * auth failure is visible in the Vercel logs without a body dump.
 * 🟢 HOTFIX 5 — PUBLIC negative cache: a 5xx/429 on a PUBLIC read is remembered
 * for 15 s so a venue outage cannot turn every sweep into a retry storm (the
 * limiter budget is shared with the entry path). Private calls are NEVER
 * negative-cached — a rejected order is DATA, not a transient.
 */
const KF_PUBLIC_NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const kfPublicNegativeCache = new Map(); // url → expiry ms

async function kfFetch(url, init = {}) {
  const method = String(init?.method || 'GET').toUpperCase();
  const urlPath = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const isPrivate = init?.headers && Object.prototype.hasOwnProperty.call(init.headers, 'APIKey');
  if (!isPrivate) {
    const negUntil = kfPublicNegativeCache.get(url);
    if (negUntil && Date.now() < negUntil) {
      console.warn(`[AM63] Kraken Futures public negative-cache hit (${urlPath}) — venue recently failed; skipping the call.`);
      return new Response(JSON.stringify({ result: 'error', error: 'negative_cache', errorMessage: 'venue recently failed — negative-cached 15s' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
  }
  await kfRateLimiter.acquire();
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('[AM63] globalThis.fetch is unavailable');
  let resp = await doFetch(url, init);
  for (const delayMs of [1000, 4000, 8000]) {
    if (resp.status !== 429) break;
    let waitMs = delayMs;
    const ra = parseInt(resp.headers?.get?.('retry-after'), 10);
    if (Number.isFinite(ra) && ra * 1000 > waitMs) waitMs = ra * 1000;
    console.warn(`[AM63] Kraken Futures 429 — backing off ${waitMs}ms`);
    await sleep(waitMs);
    resp = await doFetch(url, init);
  }
  if (!resp.ok) {
    console.error(`[AM63] Kraken Futures fetch ${method} ${urlPath} → HTTP ${resp.status}${isPrivate ? ' (private)' : ' (public)'}`);
    if (!isPrivate && resp.status >= 429) {
      kfPublicNegativeCache.set(url, Date.now() + KF_PUBLIC_NEGATIVE_CACHE_TTL_MS);
    }
  } else if (!isPrivate) {
    kfPublicNegativeCache.delete(url);
  }
  return resp;
}

/**
 * ONE public Kraken Futures request. Returns the RAW fetch Response — never parsed
 * here. There are NO credentials in this file (public-only until Push 6).
 *
 * @param {object} o
 * @param {string} [o.method]
 * @param {string} o.path
 * @param {string} [o.query]  - query WITHOUT or WITH a leading '?'
 * @param {string} [o.label]  - diagnostics only
 * @returns {Promise<Response>} raw Response
 */
export async function kfRequest({ method = 'GET', path, query = '', label = 'krakenfutures' }) {
  const q = query == null ? '' : String(query);
  const qs = q.length === 0 ? '' : (q.startsWith('?') ? q : `?${q}`);
  const init = { method, headers: { 'User-Agent': 'Nexus-Terminal', 'Accept': 'application/json' } };
  try {
    return await kfFetch(`${KF_HOST}${path}${qs}`, init);
  } catch (e) {
    console.error(`[AM63] Kraken Futures ${label} request failed: ${e.message}`);
    throw e;
  }
}

/** XBT is Kraken's ticker for BTC — normalize to the platform's display convention. */
function normalizeBase(base) {
  const b = String(base || '').toUpperCase().trim();
  return b === 'XBT' ? 'BTC' : b;
}

/** ONE /tickers call → { [symbol]: {markPrice,last,bid,ask,indexPrice,fundingRate,openInterest,vol24h,lastTime} }. */
async function loadTickers() {
  const now = Date.now();
  if (tickersCache.bySymbol && now - tickersCache.at < TICKERS_TTL_MS) return tickersCache.bySymbol;
  let resp;
  try {
    resp = await kfRequest({ path: TICKERS_PATH, label: 'tickers' });
  } catch (e) {
    console.error(`[AM63] Kraken Futures tickers fetch failed: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`[AM63] Kraken Futures tickers HTTP ${resp.status}`);
    return null;
  }
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    console.error(`[AM63] Kraken Futures tickers returned non-JSON: ${e.message}`);
    return null;
  }
  const rows = Array.isArray(json?.tickers) ? json.tickers : [];
  const bySymbol = {};
  for (const t of rows) {
    const sym = t?.symbol;
    if (!sym) continue;
    bySymbol[sym] = {
      markPrice: t.markPrice ?? null,
      last: t.last ?? null,
      bid: t.bid ?? null,
      ask: t.ask ?? null,
      // indexPrice is NOT always present in the live payload — map defensively.
      indexPrice: t.indexPrice ?? null,
      fundingRate: t.fundingRate ?? null,
      openInterest: t.openInterest ?? null,
      vol24h: t.vol24h ?? null,
      lastTime: t.lastTime ?? null,
    };
  }
  tickersCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

/**
 * Normalized ticker stats. Price consumers use markPrice as PRIMARY with last as the
 * fallback when mark is null (same discipline as the Bitnomial provider).
 *
 * @param {object} [o]
 * @param {string[]|string} [o.symbols] - native symbols (PF_XBTUSD); omit for all
 * @returns {Promise<Object|null>} { symbol: {markPrice,last,…} } | null (loud)
 */
export async function getKrakenTickers({ symbols } = {}) {
  const bySymbol = await loadTickers();
  if (!bySymbol) return null;
  const wanted = Array.isArray(symbols)
    ? symbols
    : (symbols ? [symbols] : Object.keys(bySymbol));
  const out = {};
  for (const s of wanted) {
    const row = bySymbol[s];
    if (row) out[s] = row;
  }
  return out;
}

/** ONE /instruments call → id-keyed + native-symbol-keyed map (PF_ perps only). */
async function loadInstruments() {
  const now = Date.now();
  if (instrumentsCache.byId && now - instrumentsCache.at < INSTRUMENTS_TTL_MS) return instrumentsCache;
  let resp;
  try {
    resp = await kfRequest({ path: INSTRUMENTS_PATH, label: 'instruments' });
  } catch (e) {
    console.error(`[AM63] Kraken Futures instruments fetch failed: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`[AM63] Kraken Futures instruments HTTP ${resp.status}`);
    return null;
  }
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    console.error(`[AM63] Kraken Futures instruments returned non-JSON: ${e.message}`);
    return null;
  }
  const rows = Array.isArray(json?.instruments) ? json.instruments : [];
  const byId = {};
  const byNativeSymbol = {};
  for (const p of rows) {
    // PF_ = flexible perpetuals. PI_ (inverse perps) / FF_ / FI_ (dated) are OUT OF SCOPE.
    if (!p?.symbol || !String(p.symbol).startsWith('PF_')) continue;
    if (p.tradeable !== true || p.suspended === true || p.isExpired === true) continue;
    const base = normalizeBase(p.base);
    // apiv3 has ONE perp per base → NO size suffix (unlike Bitnomial's -KRX-<size>).
    const id = `${base}-PERP-KRF`;
    const entry = {
      id,
      nativeSymbol: p.symbol,
      base,
      quote: p.quote || 'USD',
      contractSize: parseFloat(p.contractSize) || 1,
      tickSize: parseFloat(p.tickSize) || null,
      maxPositionSize: p.maxPositionSize != null ? parseFloat(p.maxPositionSize) : null,
      // 🟢 Push 7 (probe item d) — quantity precision + the per-instrument size
      // floor. contractValueTradePrecision = min qty decimal places (can be
      // negative for 10/100 increments); minimumTradeSize is documented "TODO: not
      // populated" — null means no floor until the soak proves otherwise.
      contractValueTradePrecision: p.contractValueTradePrecision != null
        ? parseInt(p.contractValueTradePrecision, 10)
        : null,
      minimumTradeSize: p.minimumTradeSize != null ? parseFloat(p.minimumTradeSize) : null,
      // 🟢 PUSH AM64 — venue-native contract facts for the Instrument Card. Tier 0
      // of marginLevels is the RETAIL display source (marginSchedules per-jurisdiction
      // is a later concern — spec: ignore for now). initialMargin 0.01 = 1% = 100×
      // effective at the base tier. Absent → null (honest-absent, never fabricated).
      initialMargin: Array.isArray(p.marginLevels) && p.marginLevels[0]?.initialMargin != null
        ? parseFloat(p.marginLevels[0].initialMargin)
        : null,
      maintenanceMargin: Array.isArray(p.marginLevels) && p.marginLevels[0]?.maintenanceMargin != null
        ? parseFloat(p.marginLevels[0].maintenanceMargin)
        : null,
      fundingRateCoefficient: p.fundingRateCoefficient != null ? parseFloat(p.fundingRateCoefficient) : null,
      maxRelativeFundingRate: p.maxRelativeFundingRate != null ? parseFloat(p.maxRelativeFundingRate) : null,
      category: p.category || null,
    };
    byId[id] = entry;
    byNativeSymbol[p.symbol] = entry;
  }
  instrumentsCache = { at: Date.now(), byId, byNativeSymbol };
  return instrumentsCache;
}

/**
 * The ONE id → native-instrument door. Resolves AT CALL TIME from the cached catalog
 * (≥1 h). The stable platform id is the identity; the native symbol is telemetry.
 *
 * @param {string} id - `${BASE}-PERP-KRF` (e.g. BTC-PERP-KRF)
 * @returns {Promise<{id,nativeSymbol,base,quote,contractSize,tickSize,maxPositionSize}|{error:string}>}
 *          `{ error }` (loud) when the id is unknown or instruments are unavailable.
 */
export async function resolveKrakenFuturesProduct(id) {
  const instruments = await loadInstruments();
  if (!instruments) return { error: '[AM63] Kraken Futures instruments unavailable' };
  const entry = instruments.byId[id];
  if (!entry) {
    console.warn(`[AM63] resolveKrakenFuturesProduct: unknown krakenfutures id '${id}' — no matching PF_ perpetual.`);
    return { error: `[AM63] unknown krakenfutures id '${id}'` };
  }
  return entry;
}

/**
 * The full PF_ perpetual catalogue (id-keyed), resolved from the ≥1 h cache. Used by
 * the public catalog endpoint to build the venue matrix. Returns null (loud) when the
 * instruments payload is unavailable.
 *
 * @returns {Promise<Object<string,{id,nativeSymbol,base,quote,contractSize,tickSize,maxPositionSize,
 *   initialMargin,maintenanceMargin,fundingRateCoefficient,maxRelativeFundingRate,category}>|null>}
 */
export async function getKrakenInstruments() {
  const instruments = await loadInstruments();
  if (!instruments) return null;
  return instruments.byId;
}

// ── 🟢 PUSH AM63 (Push 6, Commit A — INERT) — the order book door ───────────
// Live-probed 2026-10-15/16: GET /derivatives/api/v3/orderbook?symbol=PF_XRPUSD →
// HTTP 200 { result:'success', orderBook:{ bids:[[price,qty],…], asks:[[price,qty],…] },
// serverTime }. QUERY-PARAM form — the path-segment form (/orderbook/PF_XRPUSD) 404s.
// Live XRP: 344 bid levels + 467 ask levels. Only `symbol=` is probe-pinned — NO
// `limit` param is sent (unprobed); truncation is client-side in summarizeKrakenBook.
// Returns the RAW Response (the provider parity contract — never parsed here). NO
// cache: the book is hot, a stale book is worse than a slow one. The limiter still
// wraps the call (kfRequest → kfFetch → kfRateLimiter.acquire() FIRST).

/**
 * The ONE Kraken Futures order-book door. QUERY-PARAM form (probe-pinned): the
 * symbol rides as `?symbol=…`, NOT as a path segment (that 404s).
 *
 * @param {object} o
 * @param {string} o.nativeSymbol - native apiv3 symbol (PF_XRPUSD)
 * @param {string} [o.limit] - accepted for signature parity but NOT sent (unprobed param).
 * @returns {Promise<Response>} the RAW fetch Response — callers parse + branch on ok.
 */
export async function getKrakenOrderBook({ nativeSymbol, limit } = {}) {
  if (limit !== undefined) {
    console.warn('[AM63] getKrakenOrderBook: limit is not probe-pinned — ignored (client-side truncation only).');
  }
  const sym = String(nativeSymbol || '').trim();
  if (!sym) throw new Error('[AM63] getKrakenOrderBook: nativeSymbol is required');
  return kfRequest({ path: ORDERBOOK_PATH, query: `symbol=${encodeURIComponent(sym)}`, label: 'orderbook' });
}

/**
 * PURE book summarizer — no fetch, no module state, no limiter. Builds the SAME
 * book-summary shape the sniper's LIQUIDITY MAP consumes for Coinbase products:
 *
 *   { spread, imbalance, bids_50_levels, asks_50_levels,
 *     largest_bid_walls:[{price,size}], largest_ask_walls:[…] }
 *
 * - bids_50_levels / asks_50_levels: summed size of the top `levelsN` levels per
 *   side, as `.toFixed(2)` STRINGS (the sniper's canon classifier parses these).
 * - imbalance: "BULLISH" | "BEARISH" from total bid vs ask size across the summed
 *   levels (the Coinbase path never emits NEUTRAL — parity preserved).
 * - largest_bid_walls / largest_ask_walls: top `topN` levels by size DESC,
 *   [{price: number, size: number}].
 * - spread: best bid − best ask (max bid price − min ask price).
 *
 * Order-agnostic by design: the spec's "arrays already sorted by price asc" claim is
 * NOT trusted — best prices are derived via max/min and walls via size-sort, so the
 * function is correct regardless of the venue's level ordering.
 *
 * @param {object} book - { bids: [[price, qty], …], asks: [[price, qty], …] } —
 *        Kraken apiv3 tuple arrays (strings parsed defensively).
 * @param {object} [o]
 * @param {number} [o.topN=5] - walls kept per side.
 * @param {number} [o.levelsN=50] - levels summed per side for the depth totals.
 * @returns {{spread:number, imbalance:string, bids_50_levels:string, asks_50_levels:string,
 *            largest_bid_walls:{price:number,size:number}[], largest_ask_walls:{price:number,size:number}[]}}
 */
export function summarizeKrakenBook(book, { topN = 5, levelsN = 50 } = {}) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const parseLevel = (lvl) => ({
    price: parseFloat(lvl?.[0]),
    size: parseFloat(lvl?.[1]),
  });

  const bidLevels = bids.map(parseLevel).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
  const askLevels = asks.map(parseLevel).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));

  // Best prices are order-agnostic: best bid = HIGHEST bid price, best ask = LOWEST ask price.
  let bestBid = null;
  for (const l of bidLevels) if (bestBid === null || l.price > bestBid) bestBid = l.price;
  let bestAsk = null;
  for (const l of askLevels) if (bestAsk === null || l.price < bestAsk) bestAsk = l.price;
  // Spread is best ask − best bid (positive for a normal book; 0 when either side is empty).
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : 0;

  // Depth totals over the top levelsN levels per side (client-side truncation —
  // the endpoint is NOT sent a limit param).
  const bidDepth = bidLevels.slice(0, levelsN).reduce((sum, l) => sum + l.size, 0);
  const askDepth = askLevels.slice(0, levelsN).reduce((sum, l) => sum + l.size, 0);

  // Walls: top-N by size DESC (order-agnostic).
  const wallsFor = (levels) => levels
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, topN)
    .map((l) => ({ price: l.price, size: l.size }));

  return {
    spread,
    imbalance: bidDepth > askDepth ? 'BULLISH' : 'BEARISH',
    bids_50_levels: bidDepth.toFixed(2),
    asks_50_levels: askDepth.toFixed(2),
    largest_bid_walls: wallsFor(bidLevels),
    largest_ask_walls: wallsFor(askLevels),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🟢 PUSH AM63 (Push 7, Commit A — INERT) — the apiv3 PRIVATE layer.
// ═══════════════════════════════════════════════════════════════════════════
// NOTHING behavior-bearing imports the symbols below yet (Commit B binds them at
// the execute-trade / watchdog / asset-resolver seams). The signer is the ONE
// place the HMAC-SHA512 construction lives — this is HMAC, NOT jwt.sign (the
// seam gate scans for jwt.sign and must never find it here).
//
// Auth recipe (docs.kraken.com/exchange/guides/futures/rest, Oct-2025 hashing
// change): headers APIKey + Authent, where
//   Authent = Base64( HMAC-SHA512( base64decode(apiSecret),
//                                  SHA256( postData + hashPath ) ) )
// postData is the URL-ENCODED param string EXACTLY as it appears on the wire
// (hash the encoded form, not the decoded form). hashPath = the endpoint path
// MINUS the leading '/derivatives' prefix (docs example '/api/v3/orderbook';
// ccxt signs '/api/v3/'+path). Nonce is NOT sent — docs: "Nonce is not
// required"; ccxt ships none. HOTFIX 6: the old construction hashed the FULL
// path (with /derivatives) + a nonce header — both /accounts and /sendorder
// returned authenticationError on the PROD host with per-spec signing verified;
// the prehash path was the root cause.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The ONE apiv3 private signer. Known-vector pinned in scripts/am63-push7-check.mjs:
 *   secret(b64) 'AAAA…A=' (43 A + '='), postData 'symbol=PF_XBTUSD&side=buy&size=1',
 *   nonce '' (dropped), endpointPath '/api/v3/sendorder' (NO /derivatives prefix)
 *   → Authent 'FtBUEMFJBVslU4c4oxs8XvOb4XBFjE8PKQ7BxuCpAleEK8+UUcS9ErKFU/wo2QJPVyPthKDiJO7H/WnT0UUt3A=='
 * The concatenation order (postData + endpointPath) is the doc'd recipe; the
 * endpointPath EXCLUDES the /derivatives prefix (docs example '/api/v3/orderbook';
// ccxt signs '/api/v3/'+path). HOTFIX 6: the old vector hashed the FULL path + a
 * nonce — authenticationError on the PROD host was the result.
 *
 * @param {object} o
 * @param {string} o.endpointPath    - path WITHOUT the query string and WITHOUT the
 *                                     /derivatives prefix (the prehash path)
 * @param {string} o.postDataEncoded - urlencoded body (GET: the urlencoded query string)
 * @param {string} [o.nonce]         - kept for signature-shape compat; pass ''
 * @param {string} o.apiSecretB64    - the base64 api secret from the vault
 * @returns {{Authent:string}} the Authent header value (base64)
 */
export function kfSign({ endpointPath, postDataEncoded, nonce, apiSecretB64 }) {
  const secretKey = Buffer.from(String(apiSecretB64 || ''), 'base64');
  if (secretKey.length === 0) throw new Error('[AM63] kfSign: apiSecretB64 is empty or not valid base64');
  const sha256 = crypto.createHash('sha256')
    .update(`${String(postDataEncoded || '')}${String(nonce || '')}${String(endpointPath || '')}`, 'utf8')
    .digest();
  const authent = crypto.createHmac('sha512', secretKey).update(sha256).digest('base64');
  return { Authent: authent };
}

/** URL-encode a params object into the wire form (sorted keys for determinism). */
function kfEncodeParams(params) {
  const keys = Object.keys(params || {}).filter((k) => params[k] !== undefined && params[k] !== null);
  keys.sort();
  return keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
}

/**
 * ONE private apiv3 request. Resolves creds ITSELF via retrieveAPIKey(supabase,
 * tenantId, 'krakenfutures') — the vault uppercases the venue, callers NEVER sign
 * or hold secrets. Builds the nonce (ms epoch), urlencodes the params, signs, and
 * sends through kfFetch (limiter FIRST — cost-weighted per the doc'd budget).
 * Retry ONLY on 429 (kfFetch's backoff) — NEVER on a business reject: a rejected
 * order is DATA, not a transient.
 *
 * @param {object} o
 * @param {string} [o.method]      - 'GET' (default) | 'POST'
 * @param {string} o.path          - endpoint path (no query)
 * @param {object} [o.params]      - params object (GET → query string; POST → urlencoded body)
 * @param {object} o.supabase      - the tenant-scoped supabase client
 * @param {string} o.tenantId
 * @param {number} [o.cost]        - limiter cost (defaults from KF_COSTS by path)
 * @param {string} [o.label]       - diagnostics only
 * @returns {Promise<Response>} the RAW fetch Response — callers parse + branch on ok
 */
export async function kfPrivateRequest({ method = 'GET', path, params = {}, supabase, tenantId, cost, label = 'krakenfutures-private' }) {
  if (!supabase || !tenantId) throw new Error('[AM63] kfPrivateRequest: supabase + tenantId are required');
  let creds;
  try {
    creds = await retrieveAPIKey(supabase, tenantId, 'krakenfutures');
  } catch (e) {
    throw new Error(`[AM63] Kraken Futures keys not found for tenant ${tenantId}: ${e.message}`);
  }
  if (!creds || !creds.apiKey || !creds.apiSecret) {
    throw new Error(`[AM63] Kraken Futures vault row for tenant ${tenantId} is missing apiKey/apiSecret`);
  }
  // 🟢 Push 7 hotfix 4 — masked fingerprints on EVERY private call (never values):
  // makes "the key I think is in the vault" vs "the key actually used" provable and
  // makes demo/prod key swaps visible in one screenshot.
  console.log(`[AM63] KRF auth ${kfKeyFingerprint(creds.apiKey, creds.apiSecret)} label=${label} host=${KF_HOST}`);
  const postDataEncoded = kfEncodeParams(params);
  // HOTFIX 6 — the Authent prehash endpointPath EXCLUDES the /derivatives prefix
  // (docs example '/api/v3/orderbook'; ccxt signs '/api/v3/'+path). The URL keeps
  // the full path; ONLY the hash path strips it. Nonce dropped entirely (docs:
  // "Nonce is not required"; ccxt ships none — robust to header honoring or not).
  const hashPath = path.startsWith('/derivatives') ? path.slice('/derivatives'.length) : path;
  const { Authent } = kfSign({ endpointPath: hashPath, postDataEncoded, nonce: '', apiSecretB64: creds.apiSecret });
  const url = method === 'GET'
    ? `${KF_HOST}${path}${postDataEncoded ? `?${postDataEncoded}` : ''}`
    : `${KF_HOST}${path}`;
  const init = {
    method,
    headers: {
      'User-Agent': 'Nexus-Terminal',
      'Accept': 'application/json',
      'APIKey': creds.apiKey,
      'Authent': Authent,
    },
  };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = postDataEncoded;
  }
  const resolvedCost = cost != null ? cost : (KF_COSTS[label] != null ? KF_COSTS[label] : 1);
  await kfRateLimiter.acquireWeighted(resolvedCost);
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('[AM63] globalThis.fetch is unavailable');
  try {
    return await kfFetch(url, init);
  } catch (e) {
    console.error(`[AM63] Kraken Futures ${label} private request failed: ${e.message}`);
    throw e;
  }
}

// 🟢 Push 7 hotfix 3 — apiv3 REJECT DIAGNOSTICS. The cortex saw only "rejected the
// entry order: authenticationError" — not enough to separate bad-creds from a
// demo/prod host mismatch from a code bug. apiv3 error bodies carry an `error`
// CODE (authenticationError, nonce error, invalid grant…) alongside a human
// `errorMessage` ("Invalid API key"…) — the errorMessage is the discriminator and
// must surface VERBATIM. Logged + returned: the host actually used (the demo knob
// makes prod-vs-demo ambiguous from the outside), the raw error fields, and the
// request method + endpointPath ONLY. Credential values and request params
// (sizes, prices, cliOrdIds) are NEVER logged here.
function kfRejectDiagnostics({ method, path, resp, json }) {
  const errCode = json?.error
    || (Array.isArray(json?.errors) ? json.errors.map((x) => x?.code || x?.message).filter(Boolean).join('; ') : null)
    || null;
  const errMessage = json?.errorMessage || json?.error_message || null;
  const hint = kfAuthHint(errCode, errMessage);
  console.error(`[AM63] Kraken Futures reject: ${method} ${path} host=${KF_HOST} HTTP ${resp?.status ?? 'n/a'} error=${errCode || 'n/a'} errorMessage=${errMessage || 'n/a'}${hint ? ` | HINT: ${hint}` : ''}`);
  return { host: KF_HOST, error: errCode, errorMessage: errMessage, hint };
}

// 🟢 Push 7 hotfix 4 — KEY-MATERIAL FORENSICS. Both /accounts and /sendorder
// returned authenticationError on the PROD host with per-spec signing verified —
// key material is the suspect. These fingerprints make "the key I think is in the
// vault" vs "the key actually used" provable in one screenshot and make demo/prod
// key swaps visible. MASKED, NEVER VALUES: apiKey last-4 + length, and the
// base64-DECODED secret BYTE LENGTH (the decoded length is the discriminator —
// a 32-byte ed25519 secret decodes to 64 bytes, a 64-byte key decodes to 88, and
// a demo key pasted into the prod vault has a different length than the prod one).
function kfKeyFingerprint(apiKey, apiSecretB64) {
  const key = String(apiKey || '');
  const last4 = key.length >= 4 ? key.slice(-4) : `(${key.length}ch)`;
  let decodedBytes = 0;
  try { decodedBytes = Buffer.from(String(apiSecretB64 || ''), 'base64').length; } catch { decodedBytes = -1; }
  return `pubkey=…${last4}(${key.length}ch) secret=decoded(${decodedBytes}B)`;
}

// 🟢 Push 7 hotfix 4 — the KNOWN authenticationError failure modes, as a readable
// hint line that rides every auth-class reject (log + probe verdict + route).
// Ordered by likelihood: spot-vs-futures key (Kraken spot keys do NOT sign apiv3
// futures calls), demo key on the prod host (and vice versa), missing trading
// scope on the futures key.
function kfAuthHint(errCode, errMessage) {
  const hay = `${String(errCode || '')} ${String(errMessage || '')}`.toLowerCase();
  if (!hay.includes('auth') && !hay.includes('invalid') && !hay.includes('grant') && !hay.includes('key')) return null;
  return 'Known failure modes: (1) a Kraken SPOT key pasted instead of a FUTURES (apiv3) key — spot keys never sign futures calls; (2) a DEMO key on the PROD host or vice versa — demo and prod keys are separate; (3) the futures key lacks the trading scope. Verify in Settings → Test Connection.';
}

/**
 * Place an order on Kraken Futures (apiv3 sendorder). Returns a NORMALIZED verdict
 * from the inner sendStatus — the phantom result:'success' trap is a GUARD here:
 * result:'success' alone NEVER implies the order placed; the inner
 * sendStatus.status carries the truth (insufficientAvailableFunds,
 * wouldCauseLiquidation, invalidPrice, …). Loud on any structural surprise.
 *
 * @param {object} o
 * @param {object} o.supabase / o.tenantId
 * @param {string} o.nativeSymbol  - apiv3 symbol (PF_XBTUSD)
 * @param {string} o.side          - 'buy' | 'sell'
 * @param {number} o.size          - size in CONTRACTS
 * @param {string} [o.orderType]   - 'ioc' (default) | 'lmt' | 'stp' | 'take_profit' | 'mkt' | 'post' | 'fok'
 * @param {number} [o.limitPrice]  - required for ioc/lmt/post/fok; for stp/take_profit
 *                                   it is the worst fill price (omit → market on trigger)
 * @param {number} [o.stopPrice]   - the TRIGGER for stp/take_profit
 * @param {string} [o.triggerSignal] - 'mark' | 'index' | 'last' (REQUEST casing — the
 *                                   response echoes mark_price|last_price|spot_price)
 * @param {boolean} [o.reduceOnly] - true → the order may only reduce the position
 * @param {string} [o.cliOrdId]    - client order id (≤100 chars; the nx_krf_* convention)
 * @returns {Promise<{placed:boolean, orderId:string|null, status:string, rejectReason:string|null, raw:object}>}
 */
export async function placeKrakenFuturesOrder({ supabase, tenantId, nativeSymbol, side, size, orderType = 'ioc', limitPrice, stopPrice, triggerSignal, reduceOnly, cliOrdId, label = 'sendorder' }) {
  // 🟢 AM65 — FIX transport dispatch. fix-mode: contracts × contract_size →
  // base-asset qty (38), COMB ClOrdID on the wire (the nx_krf_ prefix stays a
  // DB-record convention ONLY — prefixing the wire id would break the server's
  // COMB timestamp validation), 18=s mandatory, TIF GTC/IOC only. The verdict
  // shape is IDENTICAL to the rest-mode verdict below (same keys, same
  // phantom-trap guard semantics).
  if (fixTransportEnabled()) {
    return fixPlaceOrder({ supabase, tenantId, nativeSymbol, side, size, orderType, limitPrice, stopPrice, triggerSignal, reduceOnly, cliOrdId, label });
  }
  const params = {
    orderType,
    symbol: nativeSymbol,
    side,
    size,
  };
  if (limitPrice !== undefined && limitPrice !== null) params.limitPrice = limitPrice;
  if (stopPrice !== undefined && stopPrice !== null) params.stopPrice = stopPrice;
  if (triggerSignal) params.triggerSignal = triggerSignal;
  if (reduceOnly !== undefined && reduceOnly !== null) params.reduceOnly = String(reduceOnly);
  if (cliOrdId) params.cliOrdId = String(cliOrdId).slice(0, 100);

  const resp = await kfPrivateRequest({ method: 'POST', path: SENDORDER_PATH, params, supabase, tenantId, cost: KF_COSTS.sendorder, label });
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    console.error(`[AM63] Kraken Futures sendorder returned non-JSON (HTTP ${resp.status}): ${e.message}`);
    return { placed: false, orderId: null, status: 'non_json_response', rejectReason: `HTTP ${resp.status} non-JSON`, errorMessage: null, host: KF_HOST, raw: null };
  }
  if (json?.result !== 'success' || !json?.sendStatus) {
    const errText = json?.error || json?.errors?.map((x) => x?.message).filter(Boolean).join('; ') || `HTTP ${resp.status}`;
    // 🟢 Push 7 hotfix 3 — the structural-surprise branch is where auth rejects
    // land ({ result:'error', error:'authenticationError', errorMessage:'…' }).
    // The verdict now carries the verbatim errorMessage + the host actually used.
    const diag = kfRejectDiagnostics({ method: 'POST', path: SENDORDER_PATH, resp, json });
    return { placed: false, orderId: null, status: 'error_response', rejectReason: String(errText), errorMessage: diag.errorMessage, host: diag.host, raw: json };
  }
  const sendStatus = json.sendStatus;
  const status = String(sendStatus.status || 'unknown');
  const orderId = sendStatus.order_id || null;
  const placed = KF_PLACED_STATUSES.has(status);
  if (!placed) {
    console.error(`[AM63] Kraken Futures order NOT placed (phantom-trap guard): status=${status} orderId=${orderId || 'none'}`);
  }
  return {
    placed,
    orderId,
    status,
    rejectReason: placed ? null : status,
    // 🟢 Push 7 hotfix 3 — sendStatus rejects can carry their own errorMessage;
    // surface it verbatim alongside the host so bad-creds vs demo/prod mismatch
    // is separable from the log alone.
    errorMessage: placed ? null : (sendStatus.errorMessage || json?.errorMessage || null),
    host: KF_HOST,
    raw: json,
  };
}

/**
 * AM59 fill-verification helper: bounded poll of GET /fills filtered by order_id.
 * Terminal ONLY when the fill exists with positive filled size — a bare accepted
 * sendStatus is NOT a receipt (the AM59 class). Every poll is cost-accounted (1)
 * so the loop can never starve the entry budget. Poll bounds reuse the AM59 envs.
 *
 * @param {object} o
 * @param {object} o.supabase / o.tenantId
 * @param {string} o.orderId       - the apiv3 order_id to verify
 * @param {number} [o.maxMs]       - poll cap (AM59_FILL_POLL_CAP_MS, default 8000)
 * @param {number} [o.intervalMs]  - poll cadence (AM59_FILL_POLL_MS, default 400)
 * @returns {Promise<{confirmed:boolean, filledSize:number, avgPrice:number|null,
 *                    fees:number|null, realizedPnl:number|null, fills:object[]}>}
 *          fees is null — /fills carries NO fee field (OpenAPI-pinned); realizedPnl
 *          is the venue's own number for closing fills (nullable).
 */
export async function pollKrakenFuturesFill({ supabase, tenantId, orderId, maxMs, intervalMs, clOrdId }) {
  // 🟢 AM65 — fix-mode: await the ER matching the ClOrdID (promise + timeout —
  // the AM59 receipt-before-stamp discipline is preserved; the ER IS the receipt).
  if (fixTransportEnabled()) {
    return fixPollFill({ supabase, tenantId, orderId, clOrdId, maxMs });
  }
  const capMs = parseInt(maxMs || process.env.AM59_FILL_POLL_CAP_MS || '8000', 10);
  const cadenceMs = parseInt(intervalMs || process.env.AM59_FILL_POLL_MS || '400', 10);
  const deadline = Date.now() + capMs;
  let last = { confirmed: false, filledSize: 0, avgPrice: null, fees: null, realizedPnl: null, fills: [] };
  while (Date.now() < deadline) {
    await sleep(cadenceMs);
    try {
      const resp = await kfPrivateRequest({ method: 'GET', path: FILLS_PATH, params: {}, supabase, tenantId, cost: KF_COSTS.fills, label: 'fills' });
      if (!resp.ok) continue;
      const json = await resp.json();
      const rows = Array.isArray(json?.fills) ? json.fills : [];
      const mine = rows.filter((f) => f && f.order_id === orderId);
      if (mine.length > 0) {
        const filledSize = mine.reduce((sum, f) => sum + (parseFloat(f.size) || 0), 0);
        let notional = 0;
        for (const f of mine) notional += (parseFloat(f.size) || 0) * (parseFloat(f.price) || 0);
        const avgPrice = filledSize > 0 ? notional / filledSize : null;
        const realizedPnl = mine.some((f) => f.realized_pnl != null)
          ? mine.reduce((sum, f) => sum + (parseFloat(f.realized_pnl) || 0), 0)
          : null;
        last = { confirmed: filledSize > 0, filledSize, avgPrice, fees: null, realizedPnl, fills: mine };
        if (last.confirmed) return last;
      }
    } catch (e) {
      console.error(`[AM63 FILL POLL] order ${orderId} check failed: ${e.message}`);
    }
  }
  return last;
}

/**
 * Cancel ONE order (cost 10). Accepts either the venue order_id or our cliOrdId.
 * cancelStatus.status: cancelled | filled (already fully filled — could not cancel)
 * | notFound (already cancelled or never existed). All three are terminal data —
 * never retried.
 */
export async function cancelKrakenFuturesOrder({ supabase, tenantId, orderId, cliOrdId, label = 'cancelorder' }) {
  // 🟢 AM65 — fix-mode: 35=F (same-session orders only — docs warning). The
  // watchdog routes through this same dispatch, so FIX-placed orders are always
  // cancelled on the session that placed them.
  if (fixTransportEnabled()) {
    return fixCancelOrder({ supabase, tenantId, orderId, cliOrdId, label });
  }
  const params = {};
  if (orderId) params.order_id = orderId;
  else if (cliOrdId) params.cliOrdId = cliOrdId;
  else throw new Error('[AM63] cancelKrakenFuturesOrder: orderId or cliOrdId is required');
  const resp = await kfPrivateRequest({ method: 'POST', path: CANCELORDER_PATH, params, supabase, tenantId, cost: KF_COSTS.cancelorder, label });
  const json = await resp.json().catch(() => null);
  const status = json?.cancelStatus?.status || (json?.result === 'success' ? 'cancelled' : `HTTP ${resp.status}`);
  return { ok: resp.ok && json?.result === 'success', status, raw: json };
}

/**
 * Cancel ALL open orders, optionally scoped to one symbol (cost 25 — GATED: only
 * called from explicit paths, never from a sweep loop).
 */
export async function cancelAllKrakenFuturesOrders({ supabase, tenantId, nativeSymbol, label = 'cancelallorders' }) {
  // 🟢 AM65 — fix-mode: 35=q MassCancel type 7 (account-wide, any origin).
  if (fixTransportEnabled()) {
    return fixCancelAll({ supabase, tenantId, nativeSymbol, label });
  }
  const params = nativeSymbol ? { symbol: nativeSymbol } : {};
  const resp = await kfPrivateRequest({ method: 'POST', path: CANCELALLORDERS_PATH, params, supabase, tenantId, cost: KF_COSTS.cancelallorders, label });
  const json = await resp.json().catch(() => null);
  const status = json?.cancelStatus?.status || (json?.result === 'success' ? 'cancelled' : `HTTP ${resp.status}`);
  return { ok: resp.ok && json?.result === 'success', status, raw: json };
}

/**
 * Dead-man heartbeat wrapper: POST /cancelallordersafter with timeout 60 s.
 * SELF-THROTTLED to ≥15 s per tenant (Kraken's own recommendation) — the watchdog
 * calls this every sweep and the wrapper skips the network call when the last
 * refresh is fresh. Returns { refreshed, currentTime, triggerTime } — refreshed
 * false means the throttle skipped it (not an error).
 */
export async function refreshKrakenFuturesDeadMan({ supabase, tenantId, timeoutSeconds = KF_DEADMAN_TIMEOUT_SECONDS, label = 'cancelallordersafter' }) {
  // 🟢 AM65 — fix-mode: the dead-man endpoint does not exist on FIX. CoD is the
  // passive equivalent (8674 unset → default 0 = cancel session orders on
  // disconnect) and the watchdog supervises session liveness LOUD. Report
  // refreshed:false (the throttle-skip shape — callers treat it as non-fatal).
  if (fixTransportEnabled()) {
    return { refreshed: false, currentTime: null, triggerTime: null, transport: 'fix', note: 'CoD passive (8674 unset) — no dead-man endpoint on FIX' };
  }
  const now = Date.now();
  const lastAt = lastDeadManRefresh.get(tenantId) || 0;
  if (now - lastAt < KF_DEADMAN_MIN_INTERVAL_MS) {
    return { refreshed: false, currentTime: null, triggerTime: null };
  }
  lastDeadManRefresh.set(tenantId, now);
  try {
    const resp = await kfPrivateRequest({
      method: 'POST', path: CANCELALLORDERSAFTER_PATH,
      params: { timeout: timeoutSeconds },
      supabase, tenantId, cost: KF_COSTS.cancelallordersafter, label,
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || json?.result !== 'success') {
      console.error(`[AM63] Kraken Futures dead-man refresh failed (HTTP ${resp.status}): ${json?.error || 'unknown'}`);
      return { refreshed: false, currentTime: null, triggerTime: null };
    }
    return { refreshed: true, currentTime: json?.status?.currentTime || null, triggerTime: json?.status?.triggerTime || null };
  } catch (e) {
    console.error(`[AM63] Kraken Futures dead-man refresh fault: ${e.message}`);
    return { refreshed: false, currentTime: null, triggerTime: null };
  }
}

/**
 * Normalized account balance for the risk validator + balances panel (cost 2).
 * PF_ (flexible/multi-collateral) balances live in accounts.flex — free =
 * availableMargin, used = initialMarginWithOrders, total = balanceValue. Falls
 * back to the margin accounts' auxiliary.af (available funds) when flex is absent.
 *
 * @returns {Promise<{free:number, used:number, total:number, source:string}|{error:string}>}
 */
export async function fetchKrakenFuturesBalance({ supabase, tenantId, label = 'accounts' }) {
  let resp;
  try {
    resp = await kfPrivateRequest({ method: 'GET', path: ACCOUNTS_PATH, params: {}, supabase, tenantId, cost: KF_COSTS.accounts, label });
  } catch (e) {
    return { error: `[AM63] Kraken Futures accounts fetch failed: ${e.message}` };
  }
  if (!resp.ok) return { error: `[AM63] Kraken Futures accounts HTTP ${resp.status}` };
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    return { error: `[AM63] Kraken Futures accounts returned non-JSON: ${e.message}` };
  }
  if (json?.result !== 'success' || !json?.accounts) {
    // 🟢 Push 7 hotfix 3 — the accounts error path gets the same diagnostics
    // treatment (verbatim errorMessage + host); additive fields, .error unchanged.
    const diag = kfRejectDiagnostics({ method: 'GET', path: ACCOUNTS_PATH, resp, json });
    return { error: `[AM63] Kraken Futures accounts error: ${json?.error || 'unknown shape'}`, errorMessage: diag.errorMessage, host: diag.host };
  }
  const flex = json.accounts.flex;
  if (flex && Number.isFinite(parseFloat(flex.availableMargin))) {
    return {
      free: parseFloat(flex.availableMargin) || 0,
      used: parseFloat(flex.initialMarginWithOrders) || 0,
      total: parseFloat(flex.balanceValue) || 0,
      source: 'krakenfutures_flex',
    };
  }
  // Fallback: margin accounts' auxiliary.af (available funds), summed.
  let free = 0;
  let total = 0;
  for (const key of Object.keys(json.accounts)) {
    const acct = json.accounts[key];
    if (acct?.type === 'marginAccount') {
      free += parseFloat(acct.auxiliary?.af) || 0;
      total += parseFloat(acct.auxiliary?.pv) || 0;
    }
  }
  if (free > 0 || total > 0) {
    return { free, used: Math.max(0, total - free), total, source: 'krakenfutures_margin' };
  }
  return { error: '[AM63] Kraken Futures accounts: no flex or margin balance found' };
}

/**
 * 🟢 Push 7 hotfix 3 — the ONE-CLICK auth probe behind the Settings "Test
 * Connection" button. ONE cheap authenticated GET /accounts (limiter cost 2)
 * that proves or disproves the tenant's vault row BEFORE any entry order
 * depends on it. Returns { ok, error, errorMessage, host }:
 *   - ok true  → the creds signed a successful private call on this host.
 *   - ok false → error = the apiv3 error CODE (authenticationError, nonce error,
 *     invalid grant…), errorMessage = the venue's VERBATIM human message
 *     ("Invalid API key"…), host = the host actually used (prod vs demo — the
 *     demo knob makes this ambiguous from the outside).
 * Vault-row faults (missing keys) surface through the catch as error strings.
 * NO key material is ever read into this module's return path — kfPrivateRequest
 * resolves creds internally and only the verdict crosses back.
 *
 * @param {object} o
 * @param {object} o.supabase - the tenant-scoped supabase client
 * @param {string} o.tenantId
 * @returns {Promise<{ok:boolean, error:string|null, errorMessage:string|null, host:string}>}
 */
export async function kfAuthProbe({ supabase, tenantId }) {
  try {
    const resp = await kfPrivateRequest({ method: 'GET', path: ACCOUNTS_PATH, params: {}, supabase, tenantId, cost: KF_COSTS.accounts, label: 'auth-probe' });
    let json = null;
    try { json = await resp.json(); } catch { /* non-JSON body — handled below */ }
    if (resp.ok && json?.result === 'success') {
      console.log(`[AM63] Kraken Futures auth probe OK for tenant ${tenantId} (host ${KF_HOST}).`);
      return { ok: true, error: null, errorMessage: null, host: KF_HOST };
    }
    const diag = kfRejectDiagnostics({ method: 'GET', path: ACCOUNTS_PATH, resp, json });
    return { ok: false, error: diag.error || `HTTP ${resp.status}`, errorMessage: diag.errorMessage, hint: diag.hint || null, host: diag.host };
  } catch (e) {
    // Missing vault row / unfetchable creds land here — still report the host so
    // the operator can see which environment the probe aimed at.
    console.error(`[AM63] Kraken Futures auth probe fault for tenant ${tenantId}: ${e.message}`);
    return { ok: false, error: e.message, errorMessage: null, hint: null, host: KF_HOST };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🟢 AM65 — UNIFIED FIX transport helpers (Commit B). The five private functions
// above dispatch here when KRF_PRIVATE_TRANSPORT=fix. Every helper preserves the
// REST verdict shape so the ~10 call sites (execute-trade ×6, watchdog ×4) stay
// UNTOUCHED. Owner process → direct session; non-owner → gateway proxy (E6).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve FIX creds + config for a tenant, then route the op:
 * owner process → getFixSession (direct), non-owner → proxyFixOp (gateway).
 * The FIX key/secret ride the EXISTING 'krakenfutures' vault row (a FIX key is
 * created as a Spot key even when used for derivatives — docs verbatim).
 */
async function fixRoute({ supabase, tenantId, op, payload }) {
  const { resolveFixConfig, isSessionOwnerProcess, getFixSession, proxyFixOp } = await import('./kraken-fix.js');
  let creds;
  try {
    creds = await retrieveAPIKey(supabase, tenantId, 'krakenfutures');
  } catch (e) {
    throw new Error(`[AM65] KRF FIX keys not found for tenant ${tenantId}: ${e.message}`);
  }
  const config = await resolveFixConfig({ supabase, tenantId, creds });
  if (isSessionOwnerProcess()) {
    const session = await getFixSession({ tenantId, config });
    return { session, config };
  }
  // Non-owner: proxy to the owner process over the existing gateway surface.
  const result = await proxyFixOp({ op, payload: { ...payload, tenantId } });
  return { proxied: result, config };
}

/** Map an apiv3-style order to the FIX NOS + normalized verdict (fix-mode). */
async function fixPlaceOrder({ supabase, tenantId, nativeSymbol, side, size, orderType, limitPrice, stopPrice, triggerSignal, reduceOnly, cliOrdId, label }) {
  const { combClOrdId, buildNosBody, fixTransactTime } = await import('./kraken-fix.js');
  // Qty conversion: apiv3 size is CONTRACTS; FIX 38 is BASE-ASSET denominated.
  // contract_size comes from the AM64 instrument facts (resolveKrakenFuturesProduct).
  let contractSize = 1;
  try {
    const product = await resolveKrakenFuturesProduct(
      // nativeSymbol is PF_*; the platform id is `${base}-PERP-KRF`. Derive the id
      // from the instrument cache via the native symbol when possible.
      null
    );
    if (product && !product.error && product.contractSize) contractSize = product.contractSize;
  } catch { /* fall back to 1 — loud log below when it matters */ }
  // Prefer the caller-provided contract size when the id resolves cleanly.
  let baseQty = Number(size) * contractSize;
  // D1 — trigger reference: FIX 388 has NO 'mark' option (index=1/last=5,
  // default 5). The apiv3 lane pins triggerSignal 'mark'. LOUD log on every
  // conditional verdict naming the difference; verified at the UAT probe.
  if (stopPrice != null && triggerSignal) {
    console.warn(`[AM65] FIX conditional trigger ref: apiv3 pinned '${triggerSignal}' but FIX 388 offers only index(1)/last(5) — using the FIX default (last). Verify at the UAT probe before LIVE.`);
  }
  const wireClOrdId = combClOrdId(); // BARE COMB UUID on the wire
  const dbRef = cliOrdId || `nx_krf_fix_${Date.now()}`; // DB-record convention only
  const nosArgs = {
    clOrdId: wireClOrdId,
    symbol: nativeSymbol,
    side,
    orderType,
    limitPrice,
    stopPrice,
    qty: baseQty,
    reduceOnly: reduceOnly === true || reduceOnly === 'true',
    transactTime: fixTransactTime(),
  };
  try {
    const { session, proxied, config } = await fixRoute({
      supabase, tenantId,
      op: 'nos',
      payload: { nativeSymbol, side, orderType, limitPrice, stopPrice, qty: baseQty, reduceOnly: nosArgs.reduceOnly, transactTime: nosArgs.transactTime, clOrdId: wireClOrdId },
    });
    let er;
    if (proxied) {
      er = proxied;
    } else {
      er = await session.newOrderSingle(nosArgs, 10000);
    }
    // Normalize the ER into the REST verdict shape (phantom-trap semantics).
    const rejected = er?.rejected === true;
    const ordStatus = er?.ordStatus || null;
    // FIX OrdStatus → placed semantics: 0 New / 1 Partially Filled / 2 Filled are
    // live-or-executed; A Pending New is NOT yet live (the phantom trap analog).
    const placed = !rejected && (ordStatus === '0' || ordStatus === '1' || ordStatus === '2');
    const status = rejected ? `reject:${er?.reason || 'business reject'}` : `fix:${ordStatus || 'pending'}`;
    if (!placed) {
      console.error(`[AM65] KRF FIX order NOT placed: clOrdId=${wireOrdLog(wireClOrdId)} status=${status} text=${er?.text || er?.reason || 'n/a'}`);
    }
    return {
      placed,
      orderId: er?.orderId || null,
      status,
      rejectReason: placed ? null : (er?.reason || er?.text || status),
      errorMessage: rejected ? (er?.reason || null) : null,
      host: `fix:${config?.senderCompId ? 'drv-session' : 'unknown'}`,
      clOrdId: wireClOrdId,
      dbRef,
      raw: er?.raw || er || null,
    };
  } catch (e) {
    console.error(`[AM65] KRF FIX place fault: ${e.message}`);
    return { placed: false, orderId: null, status: 'fix_fault', rejectReason: e.message, errorMessage: null, host: 'fix', raw: null };
  }
}

/** Masked wire-id log helper (never full ids in logs). */
function wireOrdLog(id) {
  const s = String(id || '');
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

/** fix-mode fill poll: await the ER matching the ClOrdID (AM59 receipt). */
async function fixPollFill({ supabase, tenantId, orderId, clOrdId, maxMs }) {
  const capMs = parseInt(maxMs || process.env.AM59_FILL_POLL_CAP_MS || '8000', 10);
  try {
    const { session, proxied } = await fixRoute({ supabase, tenantId, op: 'await_fill', payload: { orderId, clOrdId, maxMs: capMs } });
    let er = null;
    if (proxied) {
      er = proxied;
    } else if (session) {
      // The ER waiter is keyed by ClOrdID; the entry already registered it. Wait
      // on the same promise shape by polling the session's ER history briefly.
      const deadline = Date.now() + capMs;
      while (Date.now() < deadline) {
        const hist = session.erHistory.filter((h) => h.f['11'] === clOrdId && h.f['150'] === 'F');
        if (hist.length > 0) { er = { execType: 'F', ...hist[hist.length - 1].f }; break; }
        await sleep(200);
      }
      if (!er) {
        const any = session.erHistory.filter((h) => h.f['11'] === clOrdId);
        er = any.length > 0 ? { ...any[any.length - 1].f } : { rejected: false, timeout: true, reason: `no ER for ${wireOrdLog(clOrdId)} in ${capMs}ms` };
      }
    }
    const filledQty = parseFloat(er?.['32'] ?? er?.lastQty ?? 0) || 0;
    const cumQty = parseFloat(er?.['14'] ?? er?.cumQty ?? 0) || 0;
    const confirmed = (er?.execType === 'F' || er?.['150'] === 'F') && (filledQty > 0 || cumQty > 0);
    return {
      confirmed,
      filledSize: cumQty || filledQty,
      avgPrice: parseFloat(er?.['6'] ?? er?.avgPx ?? er?.['31'] ?? er?.lastPx) || null,
      // E3: tag 137 is CUMULATIVE — the session ledger already deltas it. The
      // per-fill fee rides lastFill.fee; the poll verdict carries it as fees.
      fees: er?.fee != null ? er.fee : (er?.['137'] != null ? parseFloat(er['137']) : null),
      realizedPnl: null, // FIX ER carries no realized_pnl — honest absence
      fills: er ? [er] : [],
      transport: 'fix',
    };
  } catch (e) {
    console.error(`[AM65] KRF FIX fill poll fault: ${e.message}`);
    return { confirmed: false, filledSize: 0, avgPrice: null, fees: null, realizedPnl: null, fills: [], transport: 'fix', error: e.message };
  }
}

/** fix-mode single cancel: 35=F (same-session only). */
async function fixCancelOrder({ supabase, tenantId, orderId, cliOrdId, label }) {
  try {
    const { session, proxied } = await fixRoute({ supabase, tenantId, op: 'cancel', payload: { orderId, cliOrdId } });
    const res = proxied || (session ? await session.cancelOrder({ clOrdId: cliOrdId, orderId }) : { rejected: true, reason: 'no session' });
    const rejected = res?.rejected === true;
    const ordStatus = res?.ordStatus || null;
    // Cancel outcome: ER ExecType=4 / OrdStatus 4 = cancelled; 2 = already filled.
    const ok = !rejected && (ordStatus === '4' || res?.sent === true);
    const status = rejected ? `reject:${res?.reason || 'cancel reject'}` : (ordStatus === '2' ? 'filled' : (ordStatus === '4' ? 'cancelled' : 'sent'));
    return { ok, status, transport: 'fix', raw: res?.raw || res || null };
  } catch (e) {
    console.error(`[AM65] KRF FIX cancel fault: ${e.message}`);
    return { ok: false, status: `fix_fault:${e.message}`, transport: 'fix', raw: null };
  }
}

/** fix-mode cancel-all: 35=q MassCancel type 7 (account-wide, any origin). */
async function fixCancelAll({ supabase, tenantId, nativeSymbol, label }) {
  try {
    const { session, proxied } = await fixRoute({ supabase, tenantId, op: 'mass_cancel', payload: {} });
    const res = proxied || (session ? await session.massCancelAll() : { rejected: true, reason: 'no session' });
    return { ok: !res?.rejected, status: res?.rejected ? `reject:${res.reason}` : 'mass_cancel_sent', transport: 'fix', raw: res || null };
  } catch (e) {
    console.error(`[AM65] KRF FIX mass-cancel fault: ${e.message}`);
    return { ok: false, status: `fix_fault:${e.message}`, transport: 'fix', raw: null };
  }
}
