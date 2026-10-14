// lib/providers/coinbase.js
// 🟢 PUSH AM63 — the single Coinbase transport door.
//
// Every authenticated Coinbase call in the repo signs + sends through here. This is
// Push 1 of the exchange seam (extraction only): same requests, same headers, same
// timeouts, same error paths. Push 4 (Bitnomial) copies this shape.
//
// SEALED DELTAS — the ONLY behavioral differences vs the pre-AM63 inline copies:
//   1. Canonical PEM unwrap applies `.trim()` (execute-trade-mcp's local copy did not
//      trim; coinbase-sync's did). After PEM parsing the key bytes are identical, so
//      there is ZERO signature delta. This is the sole normalization change.
//   2. Timeout parity: AbortSignal.timeout(timeoutMs) is applied ONLY when a caller
//      passes a non-null timeoutMs. Sites that had no timeout keep having none.
//
// The host `https://api.coinbase.com` lives HERE and nowhere else on the auth path.
// Public (unauthenticated) market-data fetches are out of scope for this push.

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const COINBASE_API_HOST = 'https://api.coinbase.com';

/**
 * Builds the CDP JWT for one request. Canonical signer — verbatim from
 * lib/execute-trade-mcp.js (the pre-AM63 source of truth) plus the canonical
 * PEM `.trim()`.
 *
 * @param {string} method       - HTTP method (GET, POST, ...)
 * @param {string} path         - API path; any query string is stripped from the JWT uri
 * @param {string} apiKeyName   - Coinbase CDP key name (kid)
 * @param {string} rawSecret    - PEM private key (may contain escaped \\n)
 * @returns {string} signed JWT
 */
export function generateCoinbaseToken(method, path, apiKeyName, rawSecret) {
  const formattedSecret = String(rawSecret || '').replace(/\\n/g, '\n').trim();
  const privateKey = crypto.createPrivateKey({ key: formattedSecret, format: 'pem' });
  const uriPath = path.split('?')[0];
  return jwt.sign(
    { iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, sub: apiKeyName, uri: `${method} api.coinbase.com${uriPath}` },
    privateKey,
    { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } }
  );
}

/**
 * Returns a `(method, path) => token` closure bound to one key pair — the exact
 * 2-arg shape call sites use today (`generateToken('GET', path)`), so rewires are a
 * mechanical one-line swap. Per-call PEM parse, matching the canonical
 * execute-trade-mcp closure (no memoization → no behavior delta).
 *
 * NOTE: this captures apiKeyName/rawSecret by VALUE. Only use it where both are
 * already assigned. Where the credential is assigned AFTER the closure is created
 * (e.g. execute-trade-mcp's `formattedSecret`), use an arrow that reads the
 * variable at call time instead.
 *
 * @param {string} apiKeyName
 * @param {string} rawSecret
 * @returns {(method: string, path: string) => string}
 */
export function createCoinbaseSigner(apiKeyName, rawSecret) {
  return (method, path) => generateCoinbaseToken(method, path, apiKeyName, rawSecret);
}

/**
 * ONE authenticated Coinbase request. Returns the RAW fetch Response — it never
 * parses JSON or classifies errors. Call sites keep their own resp.ok / retry /
 * error branches verbatim.
 *
 * @param {object}   opts
 * @param {string}   opts.token        - a JWT from generateCoinbaseToken/createCoinbaseSigner.
 * @param {string}   opts.method       - GET / POST ...
 * @param {string}   opts.path         - e.g. /api/v3/brokerage/orders (query allowed)
 * @param {object}   [opts.body]       - JSON body; Content-Type added only when set
 * @param {number}   [opts.timeoutMs]  - AbortSignal.timeout, ONLY when non-null
 * @param {string}   [opts.label]      - diagnostics only
 * @param {Function} [opts.fetchImpl]  - transport override (e.g. fetchWithBackoff).
 *                                       Defaults to globalThis.fetch resolved AT CALL
 *                                       TIME so test stubs (am55/am59) still intercept.
 * @returns {Promise<Response>} raw Response
 */
export async function cbRequest({
  token,
  method,
  path,
  body = null,
  timeoutMs = null,
  // eslint-disable-next-line no-unused-vars
  label = 'coinbase',
  fetchImpl = null,
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (timeoutMs != null) init.signal = AbortSignal.timeout(timeoutMs);
  return doFetch(`${COINBASE_API_HOST}${path}`, init);
}
