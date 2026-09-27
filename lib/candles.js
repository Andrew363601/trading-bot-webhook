// lib/candles.js
// 🟢 PUSH AM46 — Shared unauthenticated Coinbase candle fetcher for backtesting.
//
// DATA DOCTRINE:
// - Endpoint: https://api.coinbase.com/api/v3/brokerage/market/products/{product}/candles
// - UNAUTHENTICATED: Zero JWT, zero CDP key, zero COINBASE_API_KEY/SECRET references.
// - Product id normalization: reuses existing sniper/chat conventions.
// - Granularity: maps strategy TF enum / seconds string to Coinbase granularity.
// - Pagination: 300 candles/batch, walks oldest -> newest by epoch start/end.
// - Rate limit: shared in-process token bucket (max 5 req/s). Respects 429 Retry-After.
// - Epoch guard (AM25): parses numeric or string epoch-seconds into { time, open, high, low, close, volume }.

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';

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
