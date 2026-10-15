// lib/providers/kraken-bitnomial.js
// 🟢 PUSH AM63 (Push 4, Commit A — INERT) — the ONE Bitnomial transport door.
//
// The underlying exchange is Bitnomial (US, CFTC); the platform venue literal is
// 'kraken' everywhere — do NOT rename one into the other.
//
// Seam-to-seam parity with lib/providers/coinbase.js: this file is the ONLY place
// the `BTNL-` header strings + the HMAC-SHA256 prehash recipe live. Callers never
// sign and never hold secrets — btRequest resolves the vault creds itself.
//
// Coinbase-isms deliberately DROPPED: there is NO credential-crossover param
// (Coinbase CDP tokens do not map to BTNL). The AuthToken is a 64-hex string used
// AS UTF-8 BYTES (not hex-decoded) — mirror of their CryptoJS.HmacSHA256(prehash, token).
//
// INERT: NOTHING behavior-bearing imports this module yet. No BTP/socket/FIX code
// (Push 5). No Kraken candles/charts (honest empty state). No new timeouts.
//
// Verified contracts (bitnomial.com/exchange/docs, live-probed Oct 2026):
//   - Auth: BTNL-AUTH-TIMESTAMP (strict YYYY-MM-DDTHH:MM:SS.SSSZ, ±30 s),
//     BTNL-CONNECTION-ID (hex as-is), BTNL-SIGNATURE = base64 HMAC-SHA256.
//   - Prehash = METHOD + path + queryString + headersBlock + body
//       queryString ALWAYS carries the leading '?', even when empty;
//       headersBlock = 'BTNL-AUTH-TIMESTAMP' + ts + 'BTNL-CONNECTION-ID' + connId.
//   - Market data: public /product/data/?active=true (one call, price by product_id).
//   - Specs: public /product/specs/?active=true (id → current native symbol).
//   - 200 req / 5 min shared bucket for REST.

import crypto from 'crypto';
import { retrieveAPIKey } from '../secrets-manager.js';

const BITNOMIAL_BASE_URL = 'https://bitnomial.com';
const SPECS_PATH = '/exchange/api/v1/prod/product/specs/';
const MARKET_DATA_PATH = '/exchange/api/v1/prod/product/data/';

// ── module-scope caches (Map + TTL is the repo convention; kept as a single
//    slot each because there is exactly one dataset per endpoint) ─────────────
const STATS_TTL_MS = 15 * 1000;         // ≥15 s — one call serves a whole sweep
const SPECS_TTL_MS = 60 * 60 * 1000;    // ≥1 h — the native symbols roll quarterly

let statsCache = { at: 0, byProductId: null };
let specsCache = { at: 0, byId: null, byNativeSymbol: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── rate limiter: 200 req / 5 min, shared process-local ─────────────────────
// EVERY outbound Bitnomial call (public or private) draws from this one bucket.
// acquire() resolves when a slot frees; it never rejects for ordinary contention
// — the queue drains inside the window. Exhaustion (impossible under the queue
// model unless the window is misconfigured) surfaces as the loud [AM63] reason.
export class BtRateLimiter {
  constructor(max = 200, windowMs = 5 * 60 * 1000) {
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
        console.warn(`[AM63] Bitnomial rate limiter window elapsed — draining ${this.queue.length} queued request(s).`);
        this._drain();
      }, waitMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }
}

// The ONE shared instance. Export the instance so callers (and the gate) can
// observe the bucket; behavior code must NOT construct its own.
export const btRateLimiter = new BtRateLimiter();

/**
 * The single egress helper. Resolves globalThis.fetch AT CALL TIME (so AM55/AM59
 * test stubs still intercept), draws a limiter slot FIRST, and retries 429s with
 * backoff. NO new AbortSignal.timeout — callers that want one pass a signal.
 */
async function btFetch(url, init = {}) {
  await btRateLimiter.acquire();
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('[AM63] globalThis.fetch is unavailable');
  let resp = await doFetch(url, init);
  for (const delayMs of [1000, 4000, 8000]) {
    if (resp.status !== 429) return resp;
    let waitMs = delayMs;
    const ra = parseInt(resp.headers?.get?.('retry-after'), 10);
    if (Number.isFinite(ra) && ra * 1000 > waitMs) waitMs = ra * 1000;
    console.warn(`[AM63] Bitnomial 429 — backing off ${waitMs}ms`);
    await sleep(waitMs);
    resp = await doFetch(url, init);
  }
  return resp;
}

/**
 * Serializes + signs ONE Bitnomial private request. PURE — no I/O, no secrets in
 * the output beyond the derived signature. Returns the THREE headers verbatim.
 *
 * @param {object} o
 * @param {string} o.method       - HTTP method (GET/POST/...)
 * @param {string} o.path         - request path (no query)
 * @param {string} [o.query]      - query WITHOUT or WITH a leading '?'; empty → '?'
 * @param {string|object} [o.body]- raw body string (or object → JSON); '' when none
 * @param {string} [o.timestamp]  - strict ISO 8601; defaults to now (ms precision)
 * @param {string} o.connectionId - hex ConnectionId, as-is
 * @param {string} o.authToken    - 64-hex AuthToken, used AS UTF-8 BYTES
 * @returns {{ timestamp:string, signature:string, prehash:string,
 *            headers:{'BTNL-AUTH-TIMESTAMP':string,'BTNL-CONNECTION-ID':string,'BTNL-SIGNATURE':string} }}
 */
export function signBtRequest({ method, path, query = '', body = '', timestamp, connectionId, authToken }) {
  const ts = timestamp || strictNow();
  const q = normalizeQuery(query);
  const rawBody = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const headersBlock = `BTNL-AUTH-TIMESTAMP${ts}BTNL-CONNECTION-ID${connectionId}`;
  const prehash = `${method}${path}${q}${headersBlock}${rawBody}`;
  // AuthToken hex string used as UTF-8 bytes (Node's string key default), matching
  // their CryptoJS.HmacSHA256(prehash, btnlAuthToken) — NOT hex-decoded.
  const signature = crypto.createHmac('sha256', authToken).update(prehash, 'utf8').digest('base64');
  return {
    timestamp: ts,
    signature,
    prehash,
    headers: {
      'BTNL-AUTH-TIMESTAMP': ts,
      'BTNL-CONNECTION-ID': connectionId,
      'BTNL-SIGNATURE': signature,
    },
  };
}

/** Strict ms-precision ISO 8601: YYYY-MM-DDTHH:MM:SS.SSSZ (drops sub-ms noise). */
function strictNow() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

/** The queryString in the prehash ALWAYS carries the leading '?'. */
function normalizeQuery(query) {
  const s = query == null ? '' : String(query);
  if (s.length === 0) return '?';
  return s.startsWith('?') ? s : `?${s}`;
}

/**
 * ONE authenticated Bitnomial request. Returns the RAW fetch Response — never
 * parsed here. Resolves the vault creds itself and signs internally, so callers
 * never touch secrets or the HMAC recipe.
 *
 * @param {object} o
 * @param {string} [o.method]
 * @param {string} o.path
 * @param {string} [o.query]
 * @param {object} [o.body]        - JSON body (omit for GET)
 * @param {object} o.supabase      - service-role client
 * @param {string} o.tenantId
 * @param {string} [o.label]       - diagnostics only
 * @returns {Promise<Response>} raw Response
 */
export async function btRequest({ method = 'GET', path, query = '', body = null, supabase, tenantId, label = 'kraken' }) {
  // Vault upper-cases the exchange internally (secrets-manager on read+write) —
  // passing 'kraken' here resolves the 'KRAKEN' row. Documented asymmetry.
  const { apiKey: connectionId, apiSecret: authToken } = await retrieveAPIKey(supabase, tenantId, 'kraken');
  if (!connectionId || !authToken) {
    throw new Error(`[AM63] tenant ${tenantId} has no Kraken vault row (ConnectionId/AuthToken).`);
  }
  const q = normalizeQuery(query);
  const rawBody = body == null ? '' : JSON.stringify(body);
  const { headers } = signBtRequest({ method, path, query: q, body: rawBody, connectionId, authToken });
  const init = { method, headers: { ...headers, 'User-Agent': 'Nexus-Terminal' } };
  if (rawBody) {
    init.headers['Content-Type'] = 'application/json';
    init.body = rawBody;
  }
  try {
    return await btFetch(`${BITNOMIAL_BASE_URL}${path}${q}`, init);
  } catch (e) {
    console.error(`[AM63] Bitnomial ${label} request failed: ${e.message}`);
    throw e;
  }
}

/** ONE /product/data call → { productId: {last_price, mark_price, last_price_time} }. */
async function loadMarketData() {
  const now = Date.now();
  if (statsCache.byProductId && now - statsCache.at < STATS_TTL_MS) return statsCache.byProductId;
  let resp;
  try {
    resp = await btFetch(`${BITNOMIAL_BASE_URL}${MARKET_DATA_PATH}?active=true`);
  } catch (e) {
    console.error(`[AM63] Bitnomial market-data fetch failed: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`[AM63] Bitnomial market-data HTTP ${resp.status}`);
    return null;
  }
  let rows;
  try {
    rows = await resp.json();
  } catch (e) {
    console.error(`[AM63] Bitnomial market-data returned non-JSON: ${e.message}`);
    return null;
  }
  const byProductId = {};
  for (const p of (Array.isArray(rows) ? rows : [])) {
    const pid = p?.product_id;
    if (!pid) continue;
    byProductId[pid] = {
      last_price: p.last_price ?? null,
      mark_price: p.mark_price ?? null,
      last_price_time: p.last_price_time ?? null,
    };
  }
  statsCache = { at: Date.now(), byProductId };
  return byProductId;
}

/**
 * Normalized market stats. Price consumers use mark_price as PRIMARY with
 * last_price as the fallback when mark is null (both are present in /product/data).
 *
 * @param {object} [o]
 * @param {string[]|string} [o.productIds] - Bitnomial product_id(s); omit for all
 * @returns {Promise<Object|null>} { productId: {last_price, mark_price, last_price_time} } | null (loud)
 */
export async function getMarketStats({ productIds } = {}) {
  const byProductId = await loadMarketData();
  if (!byProductId) return null;
  const wanted = Array.isArray(productIds)
    ? productIds
    : (productIds ? [productIds] : Object.keys(byProductId));
  const out = {};
  for (const id of wanted) {
    const row = byProductId[id];
    if (row) out[id] = row;
  }
  return out;
}

/** ONE /product/specs call → id-keyed + native-symbol-keyed map. */
async function loadSpecs() {
  const now = Date.now();
  if (specsCache.byId && now - specsCache.at < SPECS_TTL_MS) return specsCache;
  let resp;
  try {
    resp = await btFetch(`${BITNOMIAL_BASE_URL}${SPECS_PATH}?active=true`);
  } catch (e) {
    console.error(`[AM63] Bitnomial specs fetch failed: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`[AM63] Bitnomial specs HTTP ${resp.status}`);
    return null;
  }
  let rows;
  try {
    rows = await resp.json();
  } catch (e) {
    console.error(`[AM63] Bitnomial specs returned non-JSON: ${e.message}`);
    return null;
  }
  const byId = {};
  const byNativeSymbol = {};
  for (const p of (Array.isArray(rows) ? rows : [])) {
    if (p?.type !== 'perpetual' || p?.product_status !== 'active') continue;
    // base MUST come from contract_size_unit — base_symbol is polluted ('BTCUC').
    const base = p.contract_size_unit;
    const id = `${base}-PERP-KRX-${p.contract_size}`;
    const entry = {
      id,
      nativeSymbol: p.symbol,
      productId: p.product_id,
      contractSize: parseFloat(p.contract_size),
      priceIncrement: parseFloat(p.price_increment) || null,
      base,
    };
    byId[id] = entry;
    if (p.symbol) byNativeSymbol[p.symbol] = entry;
  }
  specsCache = { at: Date.now(), byId, byNativeSymbol };
  return specsCache;
}

/**
 * The ONE id → native-product door. Resolves AT CALL TIME from the cached specs
 * catalog (≥1 h) because the native symbol (e.g. PBTCUCZ50) ROLLS by quarter and
 * must never be stored long-term. The stable platform id is the identity.
 *
 * @param {string} id - `${BASE}-PERP-KRX-${contractSize}` (e.g. BTC-PERP-KRX-0.01)
 * @returns {Promise<{id,nativeSymbol,productId,contractSize,priceIncrement,base}|{error:string}>}
 *          `{ error }` (loud) when the id is unknown or specs are unavailable.
 */
export async function resolveKrakenProduct(id) {
  const specs = await loadSpecs();
  if (!specs) return { error: '[AM63] Bitnomial specs unavailable' };
  const entry = specs.byId[id];
  if (!entry) {
    console.warn(`[AM63] resolveKrakenProduct: unknown kraken id '${id}' — no matching active perpetual.`);
    return { error: `[AM63] unknown kraken id '${id}'` };
  }
  return entry;
}
