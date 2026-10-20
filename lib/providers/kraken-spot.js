// lib/providers/kraken-spot.js
// 🟢 AM68 (Commit A — INERT) — the ONE Kraken SPOT (+ margin) transport door.
//
// The underlying exchange is Kraken SPOT (api.kraken.com, the classic v0 REST API).
// The platform venue literal is 'krakenspot' everywhere — do NOT confuse it with:
//   - 'kraken'        → Bitnomial (Kraken Derivatives US perps), lib/providers/kraken-bitnomial.js
//   - 'krakenfutures' → Kraken Futures apiv3 (INTL derivatives), lib/providers/kraken-futures.js
// 'kraken' is FROZEN = Bitnomial (renaming = churn); the spot lane is ADDITIVE.
//
// WHY THIS LANE EXISTS (Kraken specialist verdict, Oct 18 2026, on ticket): the
// derivatives doors (apiv3 REST + Unified FIX DRV) serve the INTERNATIONAL platform
// (PF_* instruments) and are geo-blocked for US accounts; US futures have NO Kraken
// API (KDUS/Bitnomial is manual-only; the API route is a Tradovate account). Kraken
// SPOT (+ margin) REST DOES work with the operator's existing key — agent-confirmed
// eligible ("spot margin trading is available for eligible US retail clients on
// Kraken Pro, and your profile shows you have active margin trading", incl. REST).
// Restriction pinned: TX residents cannot use margin on EUR order books → the catalog
// marks quote=EUR pairs margin:false (honest-absent for the UI).
//
// SEAM-TO-SEAM PARITY with lib/providers/coinbase.js (one-door pattern): this file is
// the ONLY place the api.kraken.com host + the HMAC-SHA512 prehash recipe live.
// Callers never sign and never hold secrets — the private request resolves the vault
// creds ITSELF via retrieveAPIKey(supabase, tenantId, 'krakenspot') (the vault
// uppercases to 'KRAKENSPOT' on write/read — documented asymmetry with the lowercase
// routing columns).
//
// ── AUTH (docs: exchange/guides/rest/authentication) ────────────────────────────
//   Headers: API-Key (public key) + API-Sign. Payload param: nonce (always-increasing
//   unsigned 64-bit; ms epoch). API-Sign =
//     base64( HMAC-SHA512( base64decode(apiSecret), URIpath + SHA256(nonce + POSTdata) ) )
//   where URIpath is the part starting '/0/private' and POSTdata is the urlencoded
//   body (WHICH INCLUDES nonce=...). NOTE the documented quirk: the prehash string is
//   nonce_value + urlencodedBody — the nonce appears BOTH as the raw prefix and inside
//   the body. The binding vector below is byte-exact against Kraken's own published
//   example (scripts/am68-check.mjs recomputes it in Node).
//
// BINDING VECTOR (docs worked example — the gate pins this byte-exact, same doctrine
// as the AM65 FIX vectors):
//   private key : kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==
//   nonce       : 1616492376594
//   post data   : nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25
//   uri path    : /0/private/AddOrder
//   API-Sign    : 4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==
//
// ── IDENTITY ───────────────────────────────────────────────────────────────────
//   id = `${BASE}-SPOT-KRS` (e.g. SOL-SPOT-KRS); BASE is the CANONICAL coin (BTC, not
//   the Kraken altname base XBT). native symbol = the Kraken altname (SOLUSD, XBTUSD).
//   normalizeVenueAssetId (lib/asset-resolver.js) strips '-SPOT-KRS' (a plain
//   one-line branch; the generic `.split('-')[0]` already yields the base).
//
// ── MARGIN (agent-confirmed eligible; REST included) ────────────────────────────
//   Entry with margin: AddOrder `leverage` param ≠ none (STRING, e.g. '5'). Venue max
//   = 5× for retail (docs: "maximum is leverage of 5") — the brain's own caps apply on
//   top. Reduce/exit: `ordertype:'settle-position'` (REST, confirmed in the OpenAPI
//   ordertype enum) settles the position; the opposite-side IOC is the fallback.
//   Bracket: v0 `close[ordertype]`/`close[price]`/`close[price2]` OTO attach.
//
// INERT (Commit A): NOTHING behavior-bearing imports this module yet. Commit B binds
// it at the catalog / execute-trade / watchdog / close-position / risk-validator seams.

import crypto from 'node:crypto';
import { retrieveAPIKey } from '../secrets-manager.js';

const KR_SPOT_HOST = 'https://api.kraken.com';

// ── public paths ────────────────────────────────────────────────────────────
const ASSET_PAIRS_PATH = '/0/public/AssetPairs';
const TICKER_PATH = '/0/public/Ticker';
const OHLC_PATH = '/0/public/OHLC';
const DEPTH_PATH = '/0/public/Depth';
const TIME_PATH = '/0/public/Time';

// ── private paths (each is its own URI-path for the signature) ───────────────
const ADD_ORDER_PATH = '/0/private/AddOrder';
const CANCEL_ORDER_PATH = '/0/private/CancelOrder';
const OPEN_ORDERS_PATH = '/0/private/OpenOrders';
const QUERY_ORDERS_PATH = '/0/private/QueryOrders';
const TRADES_HISTORY_PATH = '/0/private/TradesHistory';
const BALANCE_PATH = '/0/private/Balance';
const TRADE_BALANCE_PATH = '/0/private/TradeBalance';
const OPEN_POSITIONS_PATH = '/0/private/OpenPositions';

// ── caches (Map-style single slots, ≥1h instruments / ≥15s tickers) ──────────
const INSTRUMENTS_TTL_MS = 60 * 60 * 1000; // ≥1h — altnames/pairs roll rarely
const TICKERS_TTL_MS = 15 * 1000;          // ≥15s — one call serves a whole sweep
let instrumentsCache = { at: 0, byId: null, byNativeSymbol: null };
let tickersCache = { at: 0, byPair: null };
// 🟢 AM68 hotfix 1 — canonical AssetPairs key → altname, computed ONCE from the
// loaded catalog. /Ticker keys its result by the CANONICAL key (XXBTZUSD), not the
// altname (XBTUSD); this map lets us re-key the response so nativeSymbol lookups hit.
let tickerAliasMap = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── rate limiter: counter-based (Kraken public ~1rps guidance; private = tiered) ─
// EVERY outbound Kraken call (public or private) draws from this ONE process-local
// bucket. acquire() resolves when a slot frees; it never rejects for ordinary
// contention. Mirrors the Bitnomial/KRF limiter shape.
export class KrSpotRateLimiter {
  constructor(max = 1, windowMs = 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.timestamps = [];
    this.queue = [];
    this.timer = null;
  }

  acquire() {
    return new Promise((resolve) => {
      this.queue.push({ resolve });
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
      const waitMs = Math.max(50, this.windowMs - (now - (this.timestamps[0] ?? now)));
      this.timer = setTimeout(() => {
        this.timer = null;
        this._drain();
      }, waitMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }
}

// The ONE shared instance. Export so callers (and the gate) can observe the bucket;
// behavior code must NOT construct its own.
export const krSpotRateLimiter = new KrSpotRateLimiter();

// ── nonce: always-increasing ms epoch, strictly monotonic across calls ───────
// Kraken bans on "too many requests with invalid nonces"; a monotonic guard means
// two calls in the same millisecond can never emit a non-increasing nonce.
let lastNonce = 0;
export function krSpotNonce() {
  let n = Date.now();
  if (n <= lastNonce) n = lastNonce + 1;
  lastNonce = n;
  return String(n);
}

/**
 * PURE Kraken SPOT signature. Byte-exact against Kraken's published example.
 *
 * API-Sign = base64( HMAC-SHA512( base64decode(secret), uriPath + SHA256(nonce + postData) ) )
 *
 * @param {string} uriPath       - e.g. '/0/private/AddOrder' (the part from /0/private)
 * @param {string} nonce         - the nonce value as a string (prepended to the body)
 * @param {string} postData      - the urlencoded body INCLUDING nonce=...
 * @param {string} apiSecretB64  - the base64 private key
 * @returns {string} base64 signature
 */
export function krSpotSign(uriPath, nonce, postData, apiSecretB64) {
  // The documented encoded string: nonce_value + urlencoded_body (body itself carries nonce).
  const encoded = String(nonce) + String(postData);
  const sha256Digest = crypto.createHash('sha256').update(encoded, 'utf8').digest();
  // BINARY-SAFE concat — never string-concat the digest (would corrupt via utf8).
  const message = Buffer.concat([Buffer.from(String(uriPath), 'utf8'), sha256Digest]);
  const mac = crypto.createHmac('sha512', Buffer.from(String(apiSecretB64 || ''), 'base64')).update(message).digest();
  return mac.toString('base64');
}

/** Encodes a params object as an urlencoded body (stable insertion order). */
function krSpotEncode(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * The single PUBLIC egress helper. Resolves globalThis.fetch AT CALL TIME (so test
 * stubs still intercept), draws a limiter slot FIRST, and retries 429s with backoff.
 * Returns the RAW Response (parity contract) — callers parse.
 */
async function krSpotFetch(url, init = {}) {
  await krSpotRateLimiter.acquire();
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('[AM68] globalThis.fetch is unavailable');
  let resp = await doFetch(url, init);
  for (const delayMs of [1000, 4000]) {
    if (resp.status !== 429) return resp;
    let waitMs = delayMs;
    const ra = parseInt(resp.headers?.get?.('retry-after'), 10);
    if (Number.isFinite(ra) && ra * 1000 > waitMs) waitMs = ra * 1000;
    console.warn(`[AM68] Kraken SPOT 429 — backing off ${waitMs}ms`);
    await sleep(waitMs);
    resp = await doFetch(url, init);
  }
  return resp;
}

/**
 * The single PRIVATE egress helper. Resolves the vault creds ITSELF (never a caller
 * param), signs (headers API-Key + API-Sign), POSTs the urlencoded body. LOUD on a
 * missing vault row (never a silent Coinbase substitution — this is the same-venue
 * refusal doctrine as the KRF lane). Returns the RAW Response.
 *
 * @param {object} o
 * @param {string} o.path          - the private URI path (e.g. '/0/private/Balance')
 * @param {object} [o.params]      - body params (nonce is added automatically)
 * @param {object} o.supabase      - supabase client (creds resolve inside)
 * @param {string} o.tenantId
 */
export async function krSpotPrivateRequest({ path, params = {}, supabase, tenantId, label = 'kraken-spot' }) {
  let creds;
  // LOUD refusal when the vault row is absent — never a Coinbase substitute.
  try {
    creds = await retrieveAPIKey(supabase, tenantId, 'krakenspot');
  } catch (e) {
    throw new Error(`[AM68] Kraken SPOT not provisioned: ${e.message}. Add the spot key in Settings → API Keys → KRAKENSPOT (the same key as KRAKENFUTURES works).`);
  }
  if (!creds?.apiKey || !creds?.apiSecret) {
    throw new Error('[AM68] Kraken SPOT not provisioned: no API key on the KRAKENSPOT vault row. Add it in Settings → API Keys.');
  }

  const nonce = krSpotNonce();
  const body = krSpotEncode({ nonce, ...params });
  const sign = krSpotSign(path, nonce, body, creds.apiSecret);

  return krSpotFetch(`${KR_SPOT_HOST}${path}`, {
    method: 'POST',
    headers: {
      'API-Key': String(creds.apiKey),
      'API-Sign': sign,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Nexus-Terminal',
    },
    body,
  });
}

// ── Kraken asset → canonical coin ───────────────────────────────────────────
// Kraken historically prefixes base assets with X and quote assets with Z
// (XXBT, ZUSD). Modern payloads carry `wsname` ('XBT/USD'). We resolve the base to
// the CANONICAL coin (BTC, not XBT) so ids are venue-agnostic downstream.
const KRAKEN_ASSET_CANON = {
  XBT: 'BTC', XDG: 'DOGE', XETC: 'ETC', XXRP: 'XRP', XLTC: 'LTC',
  XMLN: 'MLN', XREP: 'REP', XXMR: 'XMR', XZEC: 'ZEC', XMOB: 'MOB',
};
function krakenCanonicalBase(rawBase) {
  let b = String(rawBase || '').toUpperCase().trim();
  // strip ONE leading X/Z prefix (Kraken's legacy asset-class prefix)
  if (b.length > 3 && (b.startsWith('X') || b.startsWith('Z'))) b = b.slice(1);
  return KRAKEN_ASSET_CANON[b] || KRAKEN_ASSET_CANON[String(rawBase || '').toUpperCase()] || b;
}

/**
 * Kraken SPOT instruments (public AssetPairs). Returns a map keyed by platform id
 * (`${BASE}-SPOT-KRS`) → catalog entry, plus a native-symbol reverse index.
 * ≥1h cache. Never a Coinbase substitute (this is the venue's own catalog).
 *
 * @returns {Promise<{byId:Object, byNativeSymbol:Object}|null>}
 */
export async function getKrakenSpotInstruments() {
  if (instrumentsCache.byId && Date.now() - instrumentsCache.at < INSTRUMENTS_TTL_MS) return instrumentsCache;
  let resp;
  try {
    resp = await krSpotFetch(`${KR_SPOT_HOST}${ASSET_PAIRS_PATH}`, { headers: { 'User-Agent': 'Nexus-Terminal' } });
  } catch (e) {
    console.error(`[AM68] Kraken SPOT AssetPairs fetch failed: ${e.message}`);
    return instrumentsCache.byId ? instrumentsCache : null;
  }
  if (!resp.ok) {
    console.error(`[AM68] Kraken SPOT AssetPairs HTTP ${resp.status}`);
    return instrumentsCache.byId ? instrumentsCache : null;
  }
  let json;
  try { json = await resp.json(); } catch (e) {
    console.error(`[AM68] Kraken SPOT AssetPairs non-JSON: ${e.message}`);
    return instrumentsCache.byId ? instrumentsCache : null;
  }
  if (Array.isArray(json?.error) && json.error.length) {
    console.error(`[AM68] Kraken SPOT AssetPairs error: ${json.error.join('; ')}`);
    return instrumentsCache.byId ? instrumentsCache : null;
  }

  const byId = {};
  const byNativeSymbol = {};
  for (const [pairId, p] of Object.entries(json?.result || {})) {
    // Skip the .d (darkpool) variants and non-crypto pairs where base/quote are absent.
    if (!p || !p.base || !p.quote) continue;
    if (String(pairId).endsWith('.d')) continue;
    const base = krakenCanonicalBase(p.base);
    const quote = String(p.quote).toUpperCase().replace(/^Z/, '') || String(p.quote).toUpperCase();
    const altname = p.altname || pairId;
    const id = `${base}-SPOT-KRS`;
    const quoteCode = quote === 'USD' ? 'USD' : quote; // ZUSD → USD
    // TX/EUR margin restriction: quote=EUR pairs are margin-ineligible (honest-absent).
    const marginEligible = quoteCode !== 'EUR';
    const entry = {
      id,
      name: id,
      base,
      quote: quoteCode,
      nativeSymbol: altname,        // Kraken altname (SOLUSD, XBTUSD)
      pairId,                       // the AssetPairs key (XXBTZUSD)
      wsname: p.wsname || null,     // 'XBT/USD'
      lot_decimals: p.lot_decimals != null ? parseInt(p.lot_decimals, 10) : null,
      pair_decimals: p.pair_decimals != null ? parseInt(p.pair_decimals, 10) : null,
      ordermin: p.ordermin != null ? parseFloat(p.ordermin) : null,
      costmin: p.costmin != null ? parseFloat(p.costmin) : null,
      tick_size: p.tick_size != null ? parseFloat(p.tick_size) : null,
      leverage_sell: Array.isArray(p.leverage_sell) ? p.leverage_sell : null,
      leverage_buy: Array.isArray(p.leverage_buy) ? p.leverage_buy : null,
      margin: marginEligible,       // false for quote=EUR (TX restriction)
      exchange: 'krakenspot',
    };
    byId[id] = entry;
    byNativeSymbol[altname] = entry;
  }

  instrumentsCache = { at: Date.now(), byId, byNativeSymbol };
  return instrumentsCache;
}

/**
 * Resolve a platform id or native symbol to a Kraken SPOT instrument. PURE w.r.t.
 * the catalog (no Coinbase fallback — unknown → { error }).
 * @param {string} idOrSymbol - 'SOL-SPOT-KRS' | 'SOLUSD'
 */
export async function resolveKrakenSpotProduct(idOrSymbol) {
  const key = String(idOrSymbol || '').toUpperCase().trim();
  if (!key) return { error: '[AM68] empty Kraken SPOT id' };
  const cat = await getKrakenSpotInstruments();
  if (!cat) return { error: '[AM68] Kraken SPOT catalog unavailable (AssetPairs)' };
  if (cat.byId[key]) return cat.byId[key];
  if (cat.byNativeSymbol[key]) return cat.byNativeSymbol[key];
  // A bare '-SPOT-KRS' id whose base we can still map from the native list.
  if (key.endsWith('-SPOT-KRS')) {
    const base = key.slice(0, key.indexOf('-SPOT-KRS'));
    const hit = Object.values(cat.byId).find((e) => e.base === base);
    if (hit) return hit;
  }
  return { error: `[AM68] Kraken SPOT product unresolved for ${idOrSymbol}` };
}

/**
 * Kraken SPOT tickers (public). Returns a map keyed by NATIVE symbol → matched row.
 * ≥15s cache (one call serves a whole sweep — pass the pair list).
 * @param {object} [o]
 * @param {string[]} [o.symbols] - native symbols to filter (optional; all when absent)
 */
export async function getKrakenSpotTickers({ symbols } = {}) {
  if (tickersCache.byPair && Date.now() - tickersCache.at < TICKERS_TTL_MS) {
    return filterTickers(tickersCache.byPair, symbols);
  }
  let resp;
  try {
    resp = await krSpotFetch(`${KR_SPOT_HOST}${TICKER_PATH}`, { headers: { 'User-Agent': 'Nexus-Terminal' } });
  } catch (e) {
    console.error(`[AM68] Kraken SPOT Ticker fetch failed: ${e.message}`);
    return tickersCache.byPair ? filterTickers(tickersCache.byPair, symbols) : null;
  }
  if (!resp.ok) {
    console.error(`[AM68] Kraken SPOT Ticker HTTP ${resp.status}`);
    return tickersCache.byPair ? filterTickers(tickersCache.byPair, symbols) : null;
  }
  let json;
  try { json = await resp.json(); } catch (e) {
    console.error(`[AM68] Kraken SPOT Ticker non-JSON: ${e.message}`);
    return tickersCache.byPair ? filterTickers(tickersCache.byPair, symbols) : null;
  }
  if (Array.isArray(json?.error) && json.error.length) {
    console.error(`[AM68] Kraken SPOT Ticker error: ${json.error.join('; ')}`);
    return tickersCache.byPair ? filterTickers(tickersCache.byPair, symbols) : null;
  }
  // 🟢 AM68 hotfix 1 — /Ticker keys its result by the CANONICAL AssetPairs key
  // (request XBTUSD → result XXBTZUSD), NOT the altname. Alias canonical→altname via
  // the catalog so downstream lookups by nativeSymbol hit. Computed once, cached.
  if (!tickerAliasMap) {
    try {
      const cat = await getKrakenSpotInstruments();
      if (cat?.byId) {
        tickerAliasMap = {};
        for (const e of Object.values(cat.byId)) {
          if (e?.pairId && e?.nativeSymbol) tickerAliasMap[e.pairId] = e.nativeSymbol;
        }
      }
    } catch (e) {
      console.warn(`[AM68] Kraken SPOT ticker alias map unavailable: ${e.message}`);
    }
  }
  const aliased = aliasTickerKeys(json?.result || {}, tickerAliasMap || {});
  tickersCache = { at: Date.now(), byPair: aliased };
  return filterTickers(aliased, symbols);
}

/**
 * PURE — re-key a canonical-keyed Ticker result map by altname. Kraken's /Ticker
 * keys its result by the CANONICAL AssetPairs key (request XBTUSD → result XXBTZUSD),
 * NOT the altname. Downstream lookups use the altname (nativeSymbol), so we alias
 * each canonical key to its altname. Keys with no known mapping are preserved as-is.
 * @param {Object} result - json.result (canonical-keyed)
 * @param {Object} pairIdToAltname - { XXBTZUSD: 'XBTUSD', … }
 */
export function aliasTickerKeys(result, pairIdToAltname) {
  const out = {};
  for (const [key, row] of Object.entries(result || {})) {
    const alt = pairIdToAltname && pairIdToAltname[key];
    out[alt || key] = row;
  }
  return out;
}

// Ticker rows are keyed by ALTNAME — aliasTickerKeys re-keys the canonical
// AssetPairs keys (AM68 hotfix 1). `c` = last trade close.
export function filterTickers(byPair, symbols) {
  const want = Array.isArray(symbols) && symbols.length
    ? new Set(symbols.map((s) => String(s).toUpperCase()))
    : null;
  const out = {};
  for (const [altname, t] of Object.entries(byPair || {})) {
    const row = {
      nativeSymbol: altname,
      last: t?.c?.[0] != null ? parseFloat(t.c[0]) : null,
      bid: t?.b?.[0] != null ? parseFloat(t.b[0]) : null,
      ask: t?.a?.[0] != null ? parseFloat(t.a[0]) : null,
      high: t?.h?.[1] != null ? parseFloat(t.h[1]) : null,
      low: t?.l?.[1] != null ? parseFloat(t.l[1]) : null,
      volume: t?.v?.[1] != null ? parseFloat(t.v[1]) : null,
      open: t?.o != null ? parseFloat(t.o) : null,
    };
    if (!want || want.has(altname)) out[altname] = row;
  }
  return out;
}

// interval (minutes) → Kraken OHLC interval token
const KR_SPOT_INTERVAL_MINUTES = {
  60: 1, 300: 5, 900: 15, 1800: 30, 3600: 60, 14400: 240, 86400: 1440,
};

/**
 * Kraken SPOT OHLC. Accepts `intervalSeconds` (the shared candle-bridge vocabulary).
 * Returns the SAME candle shape as lib/candles.js: [{time,open,high,low,close,volume}].
 * An unsupported interval yields an HONEST EMPTY (loud), never a substituted res.
 *
 * NOTE: /0/public/OHLC is DEPRECATED upstream — verify the current endpoint at
 * implementation; the returned CONTRACT SHAPE stays identical regardless.
 */
export async function getKrakenSpotCandles(nativeSymbol, intervalSeconds) {
  const interval = KR_SPOT_INTERVAL_MINUTES[Number(intervalSeconds)];
  if (!interval) {
    console.warn(`[AM68] Kraken SPOT has no ${intervalSeconds}s interval (supported: 1m/5m/15m/30m/1h/4h/1d) — returning empty.`);
    return [];
  }
  const url = `${KR_SPOT_HOST}${OHLC_PATH}?pair=${encodeURIComponent(nativeSymbol)}&interval=${interval}`;
  let resp;
  try {
    resp = await krSpotFetch(url, { headers: { 'User-Agent': 'Nexus-Terminal' } });
  } catch (e) {
    console.error(`[AM68] Kraken SPOT OHLC fetch failed for ${nativeSymbol}: ${e.message}`);
    return [];
  }
  if (!resp.ok) {
    console.error(`[AM68] Kraken SPOT OHLC HTTP ${resp.status} for ${nativeSymbol}`);
    return [];
  }
  let json;
  try { json = await resp.json(); } catch (e) {
    console.error(`[AM68] Kraken SPOT OHLC non-JSON: ${e.message}`);
    return [];
  }
  if (Array.isArray(json?.error) && json.error.length) {
    console.error(`[AM68] Kraken SPOT OHLC error: ${json.error.join('; ')}`);
    return [];
  }
  // result = { <PAIRID>: [ [time,o,h,l,c,vwap,vol,count], … ], last: <epoch> }
  // 🟢 AM68 hotfix 1 — OHLC also keys its result by the CANONICAL AssetPairs key
  // (request XBTUSD → result XXBTZUSD). Resolve via the catalog pairId, NOT the
  // requested altname; fall back to the first non-'last' entry, else honest-empty.
  const res = json?.result || {};
  let canonicalKey = null;
  try {
    const cat = await getKrakenSpotInstruments();
    const entry = cat?.byNativeSymbol?.[String(nativeSymbol).toUpperCase()];
    canonicalKey = entry?.pairId || null;
  } catch (e) {
    console.warn(`[AM68] Kraken SPOT OHLC canonical-key resolve failed for ${nativeSymbol}: ${e.message}`);
  }
  const rows = (canonicalKey && Array.isArray(res[canonicalKey]))
    ? res[canonicalKey]
    : (Object.entries(res).find(([k]) => k !== 'last')?.[1] || []);
  const candles = [];
  for (const r of rows) {
    const time = parseInt(r?.[0], 10);
    const open = parseFloat(r?.[1]);
    const high = parseFloat(r?.[2]);
    const low = parseFloat(r?.[3]);
    const close = parseFloat(r?.[4]);
    const volume = parseFloat(r?.[6]) || 0;
    if (Number.isFinite(time) && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)) {
      candles.push({ time, open, high, low, close, volume });
    }
  }
  return candles;
}

/**
 * Kraken SPOT order book (public Depth). Returns the RAW Response (parity contract) —
 * callers parse + summarize. No cache (the book is hot; a stale book is worse than a
 * slow one). `count` = level depth (Kraken caps ~500).
 */
export async function getKrakenSpotOrderBook(nativeSymbol, count = 100) {
  const url = `${KR_SPOT_HOST}${DEPTH_PATH}?pair=${encodeURIComponent(nativeSymbol)}&count=${parseInt(count, 10) || 100}`;
  await krSpotRateLimiter.acquire();
  const doFetch = globalThis.fetch;
  return doFetch(url, { headers: { 'User-Agent': 'Nexus-Terminal' } });
}

/**
 * PURE order-book summarizer — mirrors summarizeKrakenBook's SINGULAR-wall shape
 * (top-N size sum / remaining sum, largest bid/ask wall, imbalance). Kraken Depth
 * returns { bids: [[price,vol,ts], …], asks: […] } (price-ascending for bids is NOT
 * guaranteed — we sort defensively).
 */
export async function summarizeKrakenSpotBook(bookJson) {
  const pick = (arr) => (Array.isArray(arr) ? arr : []).map((l) => ({ price: parseFloat(l?.[0]), size: parseFloat(l?.[1]) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
  const bids = pick(bookJson?.bids).sort((a, b) => b.price - a.price);
  const asks = pick(bookJson?.asks).sort((a, b) => a.price - b.price);
  const top5Bids = bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
  const deepBids = bids.slice(5).reduce((s, l) => s + l.size, 0);
  const top5Asks = asks.slice(0, 5).reduce((s, l) => s + l.size, 0);
  const deepAsks = asks.slice(5).reduce((s, l) => s + l.size, 0);
  const largestBid = bids.reduce((m, l) => (l.size > m.size ? l : m), { price: 0, size: 0 });
  const largestAsk = asks.reduce((m, l) => (l.size > m.size ? l : m), { price: 0, size: 0 });
  return {
    immediate_bids: parseFloat(top5Bids.toFixed(8)),
    deep_bids: parseFloat(deepBids.toFixed(8)),
    immediate_asks: parseFloat(top5Asks.toFixed(8)),
    deep_asks: parseFloat(deepAsks.toFixed(8)),
    largest_bid_wall: largestBid,
    largest_ask_wall: largestAsk,
    imbalance: (top5Bids + deepBids) > (top5Asks + deepAsks) ? 'BULLISH' : 'BEARISH',
  };
}

/**
 * Place a Kraken SPOT (or margin) order (private AddOrder). Returns a NORMALIZED
 * verdict. Kraken returns { error: [], result: { descr, txid: [..] } } on success or
 * { error: ['EOrder:…'], result: null } on reject — the ERROR ARRAY carries the truth
 * (never assume success from a 200). `validate:true` = inert probe (no matching-engine
 * trade) — used by the Test Connection path.
 *
 * @param {object} o
 * @param {string} o.pair         - native altname (SOLUSD)
 * @param {string} o.type         - 'buy' | 'sell'
 * @param {string} o.ordertype    - 'limit' | 'market' | 'stop-loss' | 'take-profit' | 'settle-position' | …
 * @param {string|number} o.volume - qty in BASE asset
 * @param {string|number} [o.price]
 * @param {string} [o.leverage]   - margin leverage STRING (e.g. '5'); omit/'' = spot
 * @param {boolean} [o.reduceOnly]
 * @param {string} [o.clOrdId]    - ≤18 char free text or UUID
 * @param {boolean} [o.validate]  - true = validate-only (inert)
 * @param {object} o.supabase / o.tenantId
 */
export async function placeKrakenSpotOrder({ pair, type, ordertype, volume, price, leverage, reduceOnly, clOrdId, validate, timeinforce, supabase, tenantId, label = 'kraken-spot-addorder' }) {
  const params = { pair, type, ordertype, volume: String(volume) };
  if (price !== undefined && price !== null) params.price = String(price);
  if (leverage !== undefined && leverage !== null && String(leverage) !== '' && String(leverage) !== 'none') {
    params.leverage = String(leverage); // spot margin ON
  }
  if (reduceOnly) params.reduce_only = 'true';
  if (timeinforce) params.timeinforce = String(timeinforce); // GTC|IOC|GTD|FOK
  if (clOrdId) params.cl_ord_id = String(clOrdId).slice(0, 18);
  if (validate) params.validate = 'true';

  const resp = await krSpotPrivateRequest({ path: ADD_ORDER_PATH, params, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { placed: false, txid: null, status: 'non_json_response', rejectReason: `HTTP ${resp.status} non-JSON: ${e.message}`, raw: null };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  const txid = Array.isArray(json?.result?.txid) ? json.result.txid[0] : null;
  if (errs.length > 0 || !txid) {
    const rejectReason = errs.length ? errs.join('; ') : `HTTP ${resp.status} no txid`;
    console.error(`[AM68] Kraken SPOT AddOrder reject: ${rejectReason}`);
    return { placed: false, txid: null, status: 'error_response', rejectReason, raw: json };
  }
  return {
    placed: true,
    txid,
    status: 'placed',
    descr: json?.result?.descr || null,
    rejectReason: null,
    raw: json,
  };
}

/**
 * Cancel a Kraken SPOT order (private CancelOrder). Kraken returns
 * result: { count, pending? } — count 0 with the order already gone is honest.
 */
export async function cancelKrakenSpotOrder({ txid, supabase, tenantId, label = 'kraken-spot-cancel' }) {
  const resp = await krSpotPrivateRequest({ path: CANCEL_ORDER_PATH, params: { txid }, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { ok: false, count: 0, error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { ok: false, count: 0, error: errs.join('; ') };
  return { ok: true, count: parseInt(json?.result?.count, 10) || 0, pending: json?.result?.pending || null };
}

/**
 * Poll a Kraken SPOT order for its fill (private QueryOrders). The AM59
 * receipt-before-stamp semantics: a fill is confirmed ONLY when status === 'closed'
 * with a non-zero vol_exec — the caller stamps exit_price only on a confirmed receipt.
 */
export async function pollKrakenSpotFill({ txid, supabase, tenantId, label = 'kraken-spot-queryorders', attempts = 4, delayMs = 1500 }) {
  let last = { confirmed: false, status: 'unknown', filledSize: 0, avgPrice: null, fees: null, raw: null };
  for (let i = 0; i < attempts; i++) {
    const resp = await krSpotPrivateRequest({ path: QUERY_ORDERS_PATH, params: { txid }, supabase, tenantId, label });
    let json;
    try { json = await resp.json(); } catch { json = null; }
    const errs = Array.isArray(json?.error) ? json.error : [];
    const ord = json?.result?.[txid] || null;
    if (!errs.length && ord) {
      const filledSize = parseFloat(ord.vol_exec) || 0;
      const avgPrice = parseFloat(ord.price) || parseFloat(ord.avg_price) || null;
      const fees = ord.fee != null ? parseFloat(ord.fee) : null;
      const status = ord.status || 'unknown';
      last = { confirmed: status === 'closed' && filledSize > 0, status, filledSize, avgPrice, fees, raw: ord };
      if (last.confirmed) return last;
      if (['canceled', 'expired'].includes(status)) return last;
    } else if (errs.length) {
      last = { confirmed: false, status: 'error', filledSize: 0, avgPrice: null, fees: null, raw: json, error: errs.join('; ') };
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
}

/**
 * Kraken SPOT open orders (private OpenOrders) — the watchdog's resident-conditional
 * read. Returns a map keyed by txid. `trades: true` includes the trade ids.
 */
export async function getKrakenSpotOpenOrders({ supabase, tenantId, label = 'kraken-spot-openorders' }) {
  const resp = await krSpotPrivateRequest({ path: OPEN_ORDERS_PATH, params: {}, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { error: errs.join('; '), raw: json };
  const orders = {};
  for (const [txid, o] of Object.entries(json?.result?.open || {})) {
    orders[txid] = {
      txid,
      pair: o.descr?.pair || null,
      type: o.descr?.type || null,       // buy|sell
      ordertype: o.descr?.ordertype || null,
      price: o.descr?.price != null ? parseFloat(o.descr.price) : null,
      cl_ord_id: o.cl_ord_id || null,
      status: o.status || null,
      vol: o.vol != null ? parseFloat(o.vol) : null,
      raw: o,
    };
  }
  return { orders, raw: json };
}

/**
 * Kraken SPOT order status (private QueryOrders) — the native-fill forensics read.
 * Returns a map keyed by txid with status + vol_exec (filled).
 */
export async function queryKrakenSpotOrders({ txids, supabase, tenantId, label = 'kraken-spot-queryorders' }) {
  const resp = await krSpotPrivateRequest({ path: QUERY_ORDERS_PATH, params: { txid: Array.isArray(txids) ? txids.join(',') : txids }, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { error: errs.join('; '), raw: json };
  const orders = {};
  for (const [txid, o] of Object.entries(json?.result || {})) {
    orders[txid] = {
      txid,
      status: o.status || null,
      price: o.price != null ? parseFloat(o.price) : null,
      vol: o.vol != null ? parseFloat(o.vol) : null,
      vol_exec: o.vol_exec != null ? parseFloat(o.vol_exec) : 0,
      cost: o.cost != null ? parseFloat(o.cost) : null,
      fee: o.fee != null ? parseFloat(o.fee) : null,
      closetime: o.closetime || null,
      raw: o,
    };
  }
  return { orders, raw: json };
}

/**
 * Kraken SPOT account balances (private Balance) — spot holdings per asset.
 * Returns { balances: { USD: n, BTC: n, … }, raw }.
 */
export async function getKrakenSpotBalance({ supabase, tenantId, label = 'kraken-spot-balance' }) {
  const resp = await krSpotPrivateRequest({ path: BALANCE_PATH, params: {}, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { error: errs.join('; '), raw: json };
  const balances = {};
  for (const [asset, amt] of Object.entries(json?.result || {})) {
    const canon = krakenCanonicalBase(asset).replace(/^Z/, '');
    balances[canon === 'USD' ? 'USD' : canon] = parseFloat(amt) || 0;
  }
  return { balances, raw: json };
}

/**
 * Kraken SPOT trade balance (private TradeBalance) — the REAL margin-equity source
 * for the risk validator (equity + margin level, NOT just spot). Returns normalized
 * { equity_usd, available_margin, margin_level, free, source }.
 */
export async function getKrakenSpotTradeBalance({ supabase, tenantId, label = 'kraken-spot-tradebalance' }) {
  const resp = await krSpotPrivateRequest({ path: TRADE_BALANCE_PATH, params: { asset: 'ZUSD' }, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { error: errs.join('; '), raw: json };
  const r = json?.result || {};
  const equity = r.e != null ? parseFloat(r.e) : null;         // equity
  const free = r.mf != null ? parseFloat(r.mf) : null;         // margin free (available)
  const marginLevel = r.ml != null ? parseFloat(r.ml) : null;  // margin level (%)
  return {
    equity_usd: Number.isFinite(equity) ? equity : null,
    available_margin: Number.isFinite(free) ? free : null,
    margin_level: Number.isFinite(marginLevel) ? marginLevel : null,
    free: Number.isFinite(free) ? free : (Number.isFinite(equity) ? equity : null),
    source: 'kraken_spot_tradebalance',
    raw: r,
  };
}

/**
 * Kraken SPOT open margin positions (private OpenPositions) — the watchdog's
 * position-existence read for margin trades. Returns a map keyed by txid.
 */
export async function getKrakenSpotOpenPositions({ supabase, tenantId, txid, label = 'kraken-spot-openpositions' }) {
  const params = {};
  if (txid) params.txid = txid;
  const resp = await krSpotPrivateRequest({ path: OPEN_POSITIONS_PATH, params, supabase, tenantId, label });
  let json;
  try { json = await resp.json(); } catch (e) {
    return { error: `non-JSON: ${e.message}` };
  }
  const errs = Array.isArray(json?.error) ? json.error : [];
  if (errs.length) return { error: errs.join('; '), raw: json };
  const positions = {};
  for (const [id, pos] of Object.entries(json?.result || {})) {
    positions[id] = {
      txid: id,
      pair: pos.pair || null,
      type: pos.type || null,
      vol: pos.vol != null ? parseFloat(pos.vol) : null,
      vol_closed: pos.vol_closed != null ? parseFloat(pos.vol_closed) : null,
      cost: pos.cost != null ? parseFloat(pos.cost) : null,
      net: pos.net != null ? parseFloat(pos.net) : null,
      margin: pos.margin != null ? parseFloat(pos.margin) : null,
      leverage: pos.leverage != null ? parseFloat(pos.leverage) : null,
      raw: pos,
    };
  }
  return { positions, raw: json };
}

/**
 * The Settings "Test Connection" probe (private Balance, cheapest authed read).
 * Returns the venue's VERBATIM error(s) on reject — enough to separate bad-creds
 * from a missing-scope from an unprovisioned vault row in one click. No secrets.
 */
export async function krSpotAuthProbe({ supabase, tenantId }) {
  try {
    const resp = await krSpotPrivateRequest({ path: BALANCE_PATH, params: {}, supabase, tenantId, label: 'kraken-spot-probe' });
    let json;
    try { json = await resp.json(); } catch (e) {
      return { ok: false, host: KR_SPOT_HOST, error: 'non_json_response', errorMessage: `HTTP ${resp.status} non-JSON: ${e.message}` };
    }
    const errs = Array.isArray(json?.error) ? json.error : [];
    if (errs.length) {
      return { ok: false, host: KR_SPOT_HOST, error: errs[0], errorMessage: errs.join('; '), hint: krSpotAuthHint(errs.join(' ')) };
    }
    return { ok: true, host: KR_SPOT_HOST };
  } catch (e) {
    return { ok: false, host: KR_SPOT_HOST, error: e.message, errorMessage: null, hint: krSpotAuthHint(e.message) };
  }
}

/**
 * The known authentication-failure modes for the SPOT lane (a readable hint line).
 * Ordered by likelihood: futures key pasted into the spot row (spot keys DO work
 * here; a futures/apiv3 key does NOT), missing funds/withdraw permission, missing
 * vault row.
 */
export function krSpotAuthHint(errText) {
  const hay = String(errText || '').toLowerCase();
  if (!hay.includes('auth') && !hay.includes('invalid') && !hay.includes('permission') && !hay.includes('key') && !hay.includes('provisioned')) return null;
  return 'Known failure modes: (1) a Kraken FUTURES (apiv3) key pasted instead of a SPOT key — the spot lane needs a plain spot API key (query funds + trade); (2) the spot key lacks the trading/query permission; (3) the KRAKENSPOT vault row is missing entirely (Settings → API Keys). Verify in Settings → Test Connection (spot).';
}

// Re-export the paths so the watchdog/close-position can import them from ONE place
// (single-source contract — same doctrine as OPENPOSITIONS_PATH in the KRF provider).
export { OPEN_ORDERS_PATH, QUERY_ORDERS_PATH, TRADES_HISTORY_PATH, OPEN_POSITIONS_PATH, ADD_ORDER_PATH, CANCEL_ORDER_PATH };
export const KR_SPOT_HOSTNAME = KR_SPOT_HOST;
