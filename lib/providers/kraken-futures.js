// lib/providers/kraken-futures.js
// 🟢 PUSH AM63 (Push 5, Commit A — INERT) — the ONE Kraken Futures (apiv3) transport door.
//
// The underlying exchange is Kraken Futures (apiv3, futures.kraken.com). The platform
// venue literal is 'krakenfutures' everywhere — do NOT confuse it with 'kraken', which
// is Bitnomial (Kraken Derivatives US) and lives in lib/providers/kraken-bitnomial.js.
//
// ⚠️ PUBLIC-ONLY IN THIS PUSH. There are NO credentials in this file at all — every
// endpoint here is unauthenticated. Push 6 adds the apiv3 private layer (HMAC-SHA512
// signer: Authent = Base64(HMAC-SHA512(b64decode(secret), SHA256(urlencoded-postData +
// nonce + endpointPath)), Oct-2025 hashing change) + sendorder). Do NOT "complete" this
// file early by adding a signer — the private layer is a separate, deliberate push.
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

const INSTRUMENTS_PATH = '/derivatives/api/v3/instruments';
const TICKERS_PATH = '/derivatives/api/v3/tickers';

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
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this._drain();
    });
  }

  _drain() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    while (this.queue.length > 0 && this.timestamps.length < this.max) {
      this.timestamps.push(now);
      this.queue.shift().resolve();
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
 */
async function kfFetch(url, init = {}) {
  await kfRateLimiter.acquire();
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('[AM63] globalThis.fetch is unavailable');
  let resp = await doFetch(url, init);
  for (const delayMs of [1000, 4000, 8000]) {
    if (resp.status !== 429) return resp;
    let waitMs = delayMs;
    const ra = parseInt(resp.headers?.get?.('retry-after'), 10);
    if (Number.isFinite(ra) && ra * 1000 > waitMs) waitMs = ra * 1000;
    console.warn(`[AM63] Kraken Futures 429 — backing off ${waitMs}ms`);
    await sleep(waitMs);
    resp = await doFetch(url, init);
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
 * @returns {Promise<Object<string,{id,nativeSymbol,base,quote,contractSize,tickSize,maxPositionSize}>|null>}
 */
export async function getKrakenInstruments() {
  const instruments = await loadInstruments();
  if (!instruments) return null;
  return instruments.byId;
}
