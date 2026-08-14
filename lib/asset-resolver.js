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
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { retrieveAPIKey } from './secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CACHE_TTL_MS = 60000;

/** @type {Map<string, { ts: number, data: Object }>} */
const cache = new Map();

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
};

/**
 * Generates a Coinbase JWT token.
 * Mirrors the pattern in execute-trade-mcp.js (iss: 'cdp', ES256, kid header).
 *
 * @param {string} method - HTTP method (GET, POST)
 * @param {string} path - API path (e.g. /api/v3/brokerage/products/BTC-PERP-INTX)
 * @param {string} apiKeyName - Coinbase API key name
 * @param {string} apiSecret - PEM-formatted private key
 * @returns {string} Signed JWT
 */
function generateToken(method, path, apiKeyName, apiSecret) {
  const formattedSecret = apiSecret.replace(/\\n/g, '\n');
  const privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });
  const uriPath = path.split('?')[0];
  return jwt.sign(
    {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKeyName,
      uri: `${method} api.coinbase.com${uriPath}`,
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') },
    }
  );
}

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
      const resp = await fetch(`https://api.coinbase.com${apiPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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
    const cfmResp = await fetch(`https://api.coinbase.com${cfmPath}`, {
      headers: { Authorization: `Bearer ${cfmToken}` },
    });

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
    const spotResp = await fetch(`https://api.coinbase.com${spotPath}`, {
      headers: { Authorization: `Bearer ${spotToken}` },
    });

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