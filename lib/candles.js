// lib/candles.js
// 🟢 PUSH AM46 — Shared unauthenticated Coinbase candle fetcher for backtesting.
//
// 🟢 PUSH AM63 (Push 5) — a Kraken Futures (apiv3) backend was added for `-PERP-KRF`
// products. It routes through the provider's kfRequest (host + budgeted limiter live
// ONLY in lib/providers/kraken-futures.js) and maps the venue's ms-epoch / string-OHLC
// payload into the SAME candle shape the Coinbase path returns.
//
// DATA DOCTRINE:
// - Endpoint: https://api.coinbase.com/api/v3/brokerage/market/products/{product}/candles
// - UNAUTHENTICATED: Zero JWT, zero CDP key, zero COINBASE_API_KEY/SECRET references.
// - Product id normalization: reuses existing sniper/chat conventions.
// - Granularity: maps strategy TF enum / seconds string to Coinbase granularity.
// - Pagination: 300 candles/batch, walks oldest -> newest by epoch start/end.
// - Rate limit: shared in-process token bucket (max 5 req/s). Respects 429 Retry-After.
// - Epoch guard (AM25): parses numeric or string epoch-seconds into { time, open, high, low, close, volume }.

import { kfRequest, resolveKrakenFuturesProduct } from './providers/kraken-futures.js';
// 🟢 AM68 — Kraken SPOT (+ margin) REAL OHLC for `-SPOT-KRS` ids (public /0/public/OHLC).
import { getKrakenSpotCandles, resolveKrakenSpotProduct } from './providers/kraken-spot.js';

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';

// 🟢 AM63 (Push 5) — Kraken Futures chart resolutions (live-probed 2026-10-15).
// The venue supports 1m/5m/15m/30m/1h/4h/1d ONLY — 2h and 6h return HTTP 400, so
// those granularities yield an HONEST EMPTY (loud), never a substituted resolution.
const KF_SECONDS_TO_RES = {
  60: '1m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  14400: '4h',
  86400: '1d',
};

export const GRANULARITY_TO_SECONDS = {
  'ONE_MINUTE': 60,
  'FIVE_MINUTE': 300,
  'FIFTEEN_MINUTE': 900,
  'THIRTY_MINUTE': 1800,
  'ONE_HOUR': 3600,
  'TWO_HOUR': 7200,
  'SIX_HOUR': 21600,
  'ONE_DAY': 86400
};

export const SECONDS_TO_GRANULARITY = {
  60: 'ONE_MINUTE',
  300: 'FIVE_MINUTE',
  900: 'FIFTEEN_MINUTE',
  1800: 'THIRTY_MINUTE',
  3600: 'ONE_HOUR',
  7200: 'TWO_HOUR',
  21600: 'SIX_HOUR',
  86400: 'ONE_DAY'
};

/**
 * Normalizes user/strategy asset string to Coinbase product id.
 * Matches chat.js / sniper.js conventions without altering already normalized ids.
 */
export function normalizeProduct(product) {
  if (!product || typeof product !== 'string') return 'BTC-USD';
  let p = product.toUpperCase().trim();
  if (!p.includes('-')) {
    if (p.endsWith('USDT')) p = p.replace(/USDT$/, '-USDT');
    else if (p.endsWith('USD')) p = p.replace(/USD$/, '-USD');
    else if (p.endsWith('PERP')) p = p.replace(/PERP$/, '-PERP-INTX');
    else p = `${p}-USD`;
  }
  if (p.endsWith('-PERP')) p = `${p}-INTX`;
  return p;
}

/**
 * Normalizes input granularity into { granularitySeconds, granularityEnum }.
 */
export function resolveGranularity(granularity) {
  if (!granularity) {
    return { granularitySeconds: 3600, granularityEnum: 'ONE_HOUR' };
  }

  if (typeof granularity === 'number') {
    const enumVal = SECONDS_TO_GRANULARITY[granularity] || 'ONE_HOUR';
    return { granularitySeconds: granularity, granularityEnum: enumVal };
  }

  const str = String(granularity).toUpperCase().trim().replace(/\s+/g, '_');
  if (GRANULARITY_TO_SECONDS[str]) {
    return { granularitySeconds: GRANULARITY_TO_SECONDS[str], granularityEnum: str };
  }

  const numeric = parseInt(str, 10);
  if (!isNaN(numeric) && SECONDS_TO_GRANULARITY[numeric]) {
    return { granularitySeconds: numeric, granularityEnum: SECONDS_TO_GRANULARITY[numeric] };
  }

  return { granularitySeconds: 3600, granularityEnum: 'ONE_HOUR' };
}

// In-process shared token bucket rate limiter: max 5 requests per second
class TokenBucketLimiter {
  constructor(capacity = 5, fillRatePerSec = 5) {
    this.capacity = capacity;
    this.fillRate = fillRatePerSec;
    this.tokens = capacity;
    this.lastFill = Date.now();
    this.queue = [];
    this.timer = null;
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastFill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.fillRate);
    this.lastFill = now;
  }

  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (this.queue.length === 0) return;
    this._refill();

    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const nextResolve = this.queue.shift();
      nextResolve();
    }

    if (this.queue.length > 0 && !this.timer) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.fillRate) * 1000) + 10;
      this.timer = setTimeout(() => {
        this.timer = null;
        this._drainQueue();
      }, Math.max(waitMs, 20));
    }
  }
}

const sharedRateLimiter = new TokenBucketLimiter(5, 5);

/**
 * Delay helper
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 🟢 AM63 (Push 5) — Kraken Futures (apiv3) REAL OHLC backend.
 *
 * Endpoint: GET /api/charts/v1/trade/{nativeSymbol}/{res} (public, unauthenticated).
 * Routed through the provider's kfRequest so the host + budgeted limiter live ONLY in
 * lib/providers/kraken-futures.js. The venue returns:
 *   { candles: [ { time: <epoch MILLISECONDS>, open/high/low/close/volume: <STRING> } ] }
 * We convert ms→sec and parse the strings into the SAME shape the Coinbase path returns.
 *
 * An unsupported granularity (2h/6h — the venue 400s) yields an HONEST EMPTY (loud),
 * never a substituted resolution.
 *
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
async function fetchKrakenFuturesCandles({ product, stepSec, start, end }) {
  const res = KF_SECONDS_TO_RES[stepSec];
  if (!res) {
    console.warn(`[AM63] Kraken Futures has no ${stepSec}s resolution (supported: 1m/5m/15m/30m/1h/4h/1d) — returning empty.`);
    return [];
  }

  const resolved = await resolveKrakenFuturesProduct(String(product).toUpperCase().trim());
  if (!resolved || resolved.error) {
    console.warn(`[AM63] Kraken Futures candle product unresolved for ${product}: ${resolved?.error || 'no product'}`);
    return [];
  }

  const path = `/api/charts/v1/trade/${encodeURIComponent(resolved.nativeSymbol)}/${res}`;
  let resp;
  try {
    resp = await kfRequest({ path, label: 'charts' });
  } catch (e) {
    console.error(`[AM63] Kraken Futures charts fetch failed for ${resolved.nativeSymbol}/${res}: ${e.message}`);
    return [];
  }
  if (!resp.ok) {
    console.error(`[AM63] Kraken Futures charts HTTP ${resp.status} for ${resolved.nativeSymbol}/${res}`);
    return [];
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    console.error(`[AM63] Kraken Futures charts returned non-JSON: ${e.message}`);
    return [];
  }

  const rows = Array.isArray(json?.candles) ? json.candles : [];
  const candleMap = new Map();
  for (const c of rows) {
    // time is epoch MILLISECONDS → convert to epoch seconds.
    const ms = Number(c?.time);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const epochSec = Math.floor(ms / 1000);
    if (epochSec < start || epochSec > end) continue;
    const open = parseFloat(c.open);
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    const close = parseFloat(c.close);
    const volume = parseFloat(c.volume) || 0;
    if (Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)) {
      candleMap.set(epochSec, { time: epochSec, open, high, low, close, volume });
    }
  }

  return Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
}

/**
 * 🟢 AM68 — Kraken SPOT (+ margin) REAL OHLC bridge.
 *
 * Endpoint: GET /0/public/OHLC (public, unauthenticated) via lib/providers/kraken-spot.js.
 * The provider already normalizes the response into the shared candle shape; this
 * bridge resolves the `-SPOT-KRS` id to the Kraken altname (SOLUSD) and delegates.
 * An unsupported interval yields an HONEST EMPTY (loud), never a substituted resolution.
 */
async function fetchKrakenSpotCandlesBridge({ product, stepSec, start, end }) {
  const resolved = await resolveKrakenSpotProduct(String(product).toUpperCase().trim());
  if (!resolved || resolved.error) {
    console.warn(`[AM68] Kraken SPOT candle product unresolved for ${product}: ${resolved?.error || 'no product'}`);
    return [];
  }
  const candles = await getKrakenSpotCandles(resolved.nativeSymbol, stepSec);
  // The provider returns the whole series; clip to the requested window here (Kraken
  // OHLC has no start/end params — it returns the most recent N bars).
  return (candles || []).filter((c) => c.time >= start && c.time <= end);
}

/**
 * Fetches historical candles from Coinbase public market API.
 *
 * @param {Object} options
 * @param {string} options.product - Symbol/Product ID (e.g. 'BTC-USD', 'ETH-PERP-INTX', 'ETP-20DEC30-CDE')
 * @param {number|string} options.granularitySeconds - Granularity in seconds or enum (e.g. 300, 'FIVE_MINUTE')
 * @param {number} options.startEpoch - Start time in epoch seconds (inclusive)
 * @param {number} options.endEpoch - End time in epoch seconds (inclusive)
 * @returns {Promise<Array<{ time: number, open: number, high: number, low: number, close: number, volume: number }>>}
 */
export async function fetchCandles({ product, granularitySeconds, startEpoch, endEpoch }) {
  const normProduct = normalizeProduct(product);
  const { granularitySeconds: stepSec, granularityEnum } = resolveGranularity(granularitySeconds);

  let start = Math.floor(Number(startEpoch));
  let end = Math.floor(Number(endEpoch));

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error(`Invalid epoch range: start=${startEpoch}, end=${endEpoch}`);
  }

  // 🟢 AM63 (Push 5) — a Kraken Futures (apiv3) product routes to the venue's REAL
  // OHLC backend. Detection is on the RAW product (before normalizeProduct, which
  // would otherwise mangle a -PERP-KRF id into a spot symbol).
  if (String(product).toUpperCase().includes('-PERP-KRF')) {
    return fetchKrakenFuturesCandles({ product, stepSec, start, end });
  }

  // 🟢 AM68 — a Kraken SPOT (`-SPOT-KRS`) product routes to the venue's REAL OHLC
  // backend. Kraken spot HAS real candles — never the Bitnomial refuse.
  if (String(product).toUpperCase().includes('-SPOT-KRS')) {
    return fetchKrakenSpotCandlesBridge({ product, stepSec, start, end });
  }

  // Coinbase max candles per single request is 300
  const MAX_PER_CALL = 300;
  const chunkSpan = stepSec * MAX_PER_CALL;

  const candleMap = new Map(); // time -> candle object (deduplicates overlapping bounds)

  let cursorStart = start;

  while (cursorStart < end) {
    const cursorEnd = Math.min(cursorStart + chunkSpan, end);

    let attempts = 0;
    let fetched = false;

    while (!fetched && attempts < 4) {
      attempts++;
      await sharedRateLimiter.acquire();

      const url = `${COINBASE_PUBLIC_BASE}/${encodeURIComponent(normProduct)}/candles?start=${cursorStart}&end=${cursorEnd}&granularity=${encodeURIComponent(granularityEnum)}`;

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Nexus-Studio-Backtest/1.0',
            'Accept': 'application/json'
          }
        });

        if (res.status === 429) {
          const retryAfterSec = parseFloat(res.headers.get('retry-after')) || 1.5;
          console.warn(`[CANDLES] Rate limited (429) on ${normProduct}. Waiting ${retryAfterSec}s (attempt ${attempts}/4)`);
          await sleep(Math.min(retryAfterSec * 1000, 10000));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Coinbase candles HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const rawCandles = Array.isArray(data?.candles) ? data.candles : [];

        // Dual-format epoch guard (AM25):
        // Raw Coinbase returns { start, open, high, low, close, volume } descending.
        // `start` can be numeric epoch-seconds or epoch-seconds string.
        for (const c of rawCandles) {
          let epochSec = 0;
          if (typeof c.start === 'number' || /^\d+$/.test(String(c.start))) {
            epochSec = Math.floor(Number(c.start));
          } else {
            epochSec = Math.floor(new Date(c.start).getTime() / 1000);
          }

          if (!Number.isFinite(epochSec) || epochSec <= 0) continue;

          const open = parseFloat(c.open);
          const high = parseFloat(c.high);
          const low = parseFloat(c.low);
          const close = parseFloat(c.close);
          const volume = parseFloat(c.volume) || 0;

          if (Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)) {
            candleMap.set(epochSec, {
              time: epochSec,
              open,
              high,
              low,
              close,
              volume
            });
          }
        }

        fetched = true;
      } catch (err) {
        if (attempts >= 4) {
          console.error(`[CANDLES] Failed chunk ${cursorStart}-${cursorEnd} for ${normProduct}: ${err.message}`);
          throw err;
        }
        await sleep(500 * attempts);
      }
    }

    cursorStart = cursorEnd;
  }

  // Sort ascending (oldest first, newest last) exactly the shape sniper feeds strategy.run()
  const result = Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
  return result;
}
