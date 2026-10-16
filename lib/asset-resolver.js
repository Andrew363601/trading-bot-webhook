// lib/asset-resolver.js
// Single source of truth for contract specifications and real-time balance.
// Fetches from Coinbase Product API, caches briefly (60s TTL), and provides a
// standardised output regardless of which exchange the trade is for.
//
// Strategy:
//   1. Check in-memory cache (60s TTL)
//   2. Try authenticated JWT fetch (tenant API keys)
//   3. Fall back to public (unauthenticated) fetch
//   4. Last resort: hardcoded fallback specs for known assets
//   5. Return { error } only if ALL approaches fail

import { createClient } from '@supabase/supabase-js';
import { cbRequest, generateCoinbaseToken } from './providers/coinbase.js';
import { retrieveAPIKey } from './secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CACHE_TTL_MS = 60000;

/** @type {Map<string, { ts: number, data: Object }>} */
const cache = new Map();

// 🟢 PUSH AM63 (Push 6, Commit A — INERT) — the ONE venue-id → base-symbol door.
//
// Coinglass keys on the UNDERLYING symbol (XRP, DOGE, …) — venue-agnostic by design.
// The venue suffixes are platform identity, not asset identity:
//   BTC-PERP-KRF        → BTC   (Kraken Futures)
//   DOGE-PERP-KRX-5000  → DOGE  (Bitnomial; size suffix may carry a decimal, e.g. 0.01)
//   BTC-PERP-INTX       → BTC   (Coinbase)
//   ETH-PERP            → ETH
//   ETP-20DEC30-CDE     → ETP   (CDE code KEPT — the CDE→base rewrite (ETP→ETH) is a
//                                 SEPARATE seam that lives at the Coinglass call sites
//                                 (CDE_TO_BASE / FUTURES_CODE_MAP); this function must
//                                 NOT rewrite it, or the existing path changes shape.)
//   BTC                 → BTC   (already bare)
//
// PURE: no fetch, no cache, no module state. The gateway's inline strip regex and the
// coinglass-indicator route's normalizeBaseTicker both route through this in Commit B
// (same seam, single-sourced). NEVER leak the normalized base code into UI-facing
// payloads that previously carried the venue id (existing doctrine).
/**
 * Normalizes ANY platform asset id to its base symbol for venue-agnostic lookups
 * (Coinglass keys on the underlying, not the venue).
 *
 * @param {string} id - any platform asset id (BTC-PERP-KRF, DOGE-PERP-KRX-5000,
 *        ETP-20DEC30-CDE, BTC-PERP-INTX, ETH-PERP, BTC, …)
 * @returns {string} the base symbol (BTC, DOGE, ETP, …). Empty string for empty input.
 */
export function normalizeVenueAssetId(id) {
  let s = String(id || '').toUpperCase().trim();
  if (!s) return '';
  // Venue suffixes FIRST (the size suffix may itself contain a dash-separated token
  // or a decimal — slice at the marker, don't regex the tail).
  const krf = s.indexOf('-PERP-KRF');
  if (krf !== -1) s = s.slice(0, krf);
  const krx = s.indexOf('-PERP-KRX-');
  if (krx !== -1) s = s.slice(0, krx);
  // Then the existing generic suffixes (same regex the gateway/route used inline).
  s = s.replace(/(-PERP-INTX|-PERP|-INTX|-CDE|-USDT|-USDC|-USD)/g, '');
  // Leading segment (handles dated futures like ETP-20DEC30).
  s = s.split('-')[0];
  return s;
}

/**
 * Fallback specs for known assets when the Coinbase Product API is unreachable.
 * Used only for PAPER mode — LIVE blocks on assets with no API-confirmed specs.
 * Values mirror the old getAssetMetrics() hardcoded table.
 */
const FALLBACK_SPECS = {
  'ETH-PERP-INTX':  { contract_size: 0.1,    quote_increment: 0.50 },
  'BTC-PERP-INTX':  { contract_size: 0.01,   quote_increment: 5.00 },
  'SOL-PERP-INTX':  { contract_size: 5.0,    quote_increment: 0.01 },
  'DOGE-PERP-INTX': { contract_size: 1000.0, quote_increment: 0.0001 },
  'LTC-PERP-INTX':  { contract_size: 1.0,    quote_increment: 0.01 },
  'AVAX-PERP-INTX': { contract_size: 1.0,    quote_increment: 0.01 },
  'LINK-PERP-INTX': { contract_size: 1.0,    quote_increment: 0.001 },
  // 🟢 AM60 (ADD) — Bitcoin Cash. CDE perp code is BCP ("BCH PERP"),
  // contract_size 1, price_increment 0.05 (Coinbase product spec). Kept for parity.
  'BCP-20DEC30-CDE': { contract_size: 1.0,   quote_increment: 0.05 },
  'BCH-20DEC30-CDE': { contract_size: 1.0,   quote_increment: 0.05 },
  'BCH-PERP-INTX':   { contract_size: 1.0,   quote_increment: 0.05 },
};

// AM63 — signing is delegated to the canonical provider (lib/providers/coinbase.js).
const generateToken = generateCoinbaseToken;

/**
 * Parses the Coinbase Product API JSON response into a standardised asset
 * specs object.
 *
 * @param {Object} json - Raw Coinbase /api/v3/brokerage/products/{id} response
 * @param {string} symbol - Normalised symbol (e.g. 'ETH-PERP-INTX')
 * @param {string} exchange - Exchange identifier
 * @returns {Object} Standardised asset specs
 */
function parseProductResponse(json, symbol, exchange) {
  const fp = json.future_product_details || {};
  const perp = fp.perpetual_details || {};
  const margin = fp.intraday_margin_rate || {};

  return {
    exchange,
    symbol,
    contract_size: parseFloat(fp.contract_size) || null,
    max_leverage: parseFloat(perp.max_leverage) || null,
    base_min_size: parseFloat(json.base_min_size) || 1,
    base_max_size: parseFloat(json.base_max_size) || null,
    quote_increment: parseFloat(json.quote_increment) || 0.01,
    margin_rate: {
      long: parseFloat(margin.long_margin_rate) || null,
      short: parseFloat(margin.short_margin_rate) || null,
    },
    cached_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Fetches contract specifications for a given symbol from Coinbase.
 *
 * Tries authenticated JWT first (for LIVE tenants with API keys), then public
 * (for PAPER mode), then falls back to hardcoded specs for known assets.
 * Results are cached in memory for 60 seconds.
 *
 * @param {string} tenantId - The tenant UUID
 * @param {string} symbol - e.g. 'ETH-PERP-INTX' or 'BTC-PERP'
 * @param {string} [exchange='coinbase'] - Exchange identifier (future: 'binance', 'bybit')
 * @returns {Promise<Object>} Asset specs or { error: string }
 */
export async function getAssetSpecs(tenantId, symbol, exchange = 'coinbase') {
  if (exchange !== 'coinbase') {
    return { error: `Exchange '${exchange}' not yet supported.` };
  }

  const normalizedSymbol = symbol.toUpperCase().trim();
  const key = `specs:${normalizedSymbol}`;

  // 1. Check cache
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  // Normalise product ID — Coinbase expects exact product IDs
  let productId = normalizedSymbol;
  if (!productId.includes('-')) {
    productId = `${normalizedSymbol}-PERP-INTX`;
  }
  if (productId.endsWith('-PERP')) {
    productId = `${productId}-INTX`;
  }

  const apiPath = `/api/v3/brokerage/products/${productId}`;

  // 2. Try authenticated fetch (JWT with tenant API keys)
  try {
    const keys = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
    if (keys?.apiKey && keys?.apiSecret) {
      const token = generateToken('GET', apiPath, keys.apiKey, keys.apiSecret);
      const resp = await cbRequest({ token: `${token}`, method: 'GET', path: `${apiPath}` });
      if (resp.ok) {
        const json = await resp.json();
        const specs = parseProductResponse(json, normalizedSymbol, exchange);
        cache.set(key, { ts: Date.now(), data: specs });
        return specs;
      }
      console.warn(
        `[ASSET RESOLVER] Auth'd fetch returned ${resp.status} for ${productId}. Trying public...`
      );
    }
  } catch (e) {
    console.warn(
      `[ASSET RESOLVER] Auth'd fetch failed for ${productId}: ${e.message}. Trying public...`
    );
  }

  // 3. Fallback: try public (unauthenticated — PAPER mode, no API keys)
  try {
    const resp = await fetch(`https://api.coinbase.com${apiPath}`);
    if (resp.ok) {
      const json = await resp.json();
      const specs = parseProductResponse(json, normalizedSymbol, exchange);
      cache.set(key, { ts: Date.now(), data: specs });
      return specs;
    }
    console.warn(
      `[ASSET RESOLVER] Public fetch returned ${resp.status} for ${productId}.`
    );
  } catch (e) {
    console.warn(
      `[ASSET RESOLVER] Public fetch failed for ${productId}: ${e.message}`
    );
  }

  // 4. Last resort: hardcoded fallback for known assets
  const fallback = FALLBACK_SPECS[productId] || FALLBACK_SPECS[normalizedSymbol];
  if (fallback) {
    console.warn(`[ASSET RESOLVER] Using fallback specs for ${normalizedSymbol}.`);
    const specs = {
      exchange,
      symbol: normalizedSymbol,
      contract_size: fallback.contract_size,
      max_leverage: null,
      base_min_size: 1,
      base_max_size: null,
      quote_increment: fallback.quote_increment,
      margin_rate: { long: null, short: null },
      cached_at: Math.floor(Date.now() / 1000),
      _fallback: true,
    };
    cache.set(key, { ts: Date.now(), data: specs });
    return specs;
  }

  return { error: `Unable to fetch asset specs for ${normalizedSymbol}` };
}

/**
 * Fetches the real-time account balance from Coinbase for a tenant.
 *
 * Queries CFM futures balance first, then falls back to spot USD/USDC balances.
 * Requires the tenant's Coinbase API keys to be configured.
 *
 * @param {string} tenantId - The tenant UUID
 * @param {string} [exchange='coinbase'] - Exchange identifier
 * @returns {Promise<Object>} { balance_usd: number, source: string } or { error: string }
 */
export async function getRealBalance(tenantId, exchange = 'coinbase') {
  if (exchange !== 'coinbase') {
    return { error: `Exchange '${exchange}' not yet supported.` };
  }

  try {
    const keys = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
    if (!keys?.apiKey || !keys?.apiSecret) {
      return { error: 'No API keys configured.' };
    }

    // Try CFM futures balance first
    const cfmPath = '/api/v3/brokerage/cfm/balance_summary';
    const cfmToken = generateToken('GET', cfmPath, keys.apiKey, keys.apiSecret);
    const cfmResp = await cbRequest({ token: `${cfmToken}`, method: 'GET', path: `${cfmPath}` });

    if (cfmResp.ok) {
      const cfmData = await cfmResp.json();
      const balance = parseFloat(
        cfmData.balance_summary?.total_balance?.value ||
          cfmData.balance_summary?.total_usd_balance?.value ||
          cfmData.balance_summary?.futures_margin_balance?.value ||
          0
      );
      if (balance > 0) {
        return { balance_usd: balance, source: 'coinbase_cfm' };
      }
    }

    // Fallback: spot USD/USDC balance
    const spotPath = '/api/v3/brokerage/accounts';
    const spotToken = generateToken('GET', spotPath, keys.apiKey, keys.apiSecret);
    const spotResp = await cbRequest({ token: `${spotToken}`, method: 'GET', path: `${spotPath}` });

    if (spotResp.ok) {
      const spotData = await spotResp.json();
      const usdAccounts = (spotData.accounts || []).filter(
        (a) => a.currency === 'USD' || a.currency === 'USDC'
      );
      const balance = usdAccounts.reduce(
        (sum, acc) => sum + parseFloat(acc.available_balance?.value || 0),
        0
      );
      if (balance > 0) {
        return { balance_usd: balance, source: 'coinbase_spot' };
      }
    }

    return { balance_usd: 0, source: 'coinbase' };
  } catch (e) {
    console.error(`[ASSET RESOLVER] Balance fetch failed: ${e.message}`);
    return { error: `Unable to fetch balance: ${e.message}` };
  }
}