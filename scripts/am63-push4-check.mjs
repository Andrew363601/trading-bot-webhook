// scripts/am63-push4-check.mjs
// 🟢 PUSH AM63 (Push 4) GATE — the Bitnomial/Kraken adapter.
//
// Enforces the Push 4 contract:
//   1  lib/providers/kraken-bitnomial.js exists with the pinned exports.
//   2  Prehash + BTNL header serialization shape (contract 1) + a fixture test
//      that pins OUR prehash construction byte-for-byte and the HMAC determinism
//      (we cannot pin their printed signature without their secret).
//   3  The rate limiter wraps EVERY Bitnomial fetch in the provider; the bucket
//      is a shared process-local singleton.
//   4  btRequest returns the RAW fetch Response; creds resolve via
//      retrieveAPIKey(supabase, tenantId, 'kraken') — callers never sign.
//   5  NO Coinbase-isms: no `cross` param anywhere.
//   6  Commit A is INERT — no behavior-bearing file imports the provider.
//   7  R2-style: no `bitnomial` host fetch outside the provider.
//   8  Commit B (guarded by REPORT_ONLY): execute-trade's kraken paper-proceeds /
//      live-refuses branch, watchdog + reevaluate pricing branches, risk-validator
//      + getAssetMetrics venue branches, shadow-portfolio loud skip, router
//      accepts 'kraken' (unknown still throws).
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push4-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
// Commit A shipped this gate REPORT-ONLY (it inspects Commit B's wiring, which did
// not exist yet). Commit B flips this to false and the gate enforces.
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'scripts']);

const PROVIDER = 'lib/providers/kraken-bitnomial.js';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => { try { readFileSync(path.join(ROOT, rel)); return true; } catch { return false; } };

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// Walk repo source files (excluding scripts/ so this gate's own strings never match).
const files = [];
(function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name));
    } else if (/\.(js|mjs|cjs)$/.test(ent.name)) {
      files.push(path.join(dir, ent.name));
    }
  }
})(ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── 1. Provider exists + exports (behavioural import) ───────────────────────
if (!exists(PROVIDER)) {
  check('kraken-bitnomial.js provider exists', false, PROVIDER + ' not found');
} else {
  let mod = null;
  try {
    mod = await import('../lib/providers/kraken-bitnomial.js');
    check('provider imports cleanly', true);
  } catch (e) {
    check('provider imports cleanly', false, e.message);
  }
  if (mod) {
    check('provider exports signBtRequest', typeof mod.signBtRequest === 'function');
    check('provider exports btRequest', typeof mod.btRequest === 'function');
    check('provider exports getMarketStats', typeof mod.getMarketStats === 'function');
    check('provider exports resolveKrakenProduct', typeof mod.resolveKrakenProduct === 'function');
    check('provider exports BtRateLimiter class', typeof mod.BtRateLimiter === 'function');
    check('provider exports a shared btRateLimiter instance', !!mod.btRateLimiter && typeof mod.btRateLimiter.acquire === 'function');
  }
}

// ── 2. Prehash + header shape (static pins) ─────────────────────────────────
if (exists(PROVIDER)) {
  const src = read(PROVIDER);
  check("BTNL-AUTH-TIMESTAMP header literal", /'BTNL-AUTH-TIMESTAMP'/.test(src));
  check("BTNL-CONNECTION-ID header literal", /'BTNL-CONNECTION-ID'/.test(src));
  check("BTNL-SIGNATURE header literal", /'BTNL-SIGNATURE'/.test(src));
  check('headersBlock = name/value concatenation, no separators',
    /BTNL-AUTH-TIMESTAMP\$\{ts\}BTNL-CONNECTION-ID\$\{connectionId\}/.test(src));
  check('prehash = METHOD + path + query + headersBlock + body',
    /\$\{method\}\$\{path\}\$\{q\}\$\{headersBlock\}\$\{rawBody\}/.test(src));
  check("queryString ALWAYS carries the leading '?'", /return '\?';/.test(src));
  check('HMAC-SHA256 + base64 of the AuthToken used as UTF-8 bytes',
    /createHmac\(\s*'sha256'\s*,\s*authToken\s*\)/.test(src) && /\.digest\(\s*'base64'\s*\)/.test(src));
  check('strict ms-precision ISO 8601 timestamp helper', /toISOString\(\)\.replace\(\/\\?\(\\\.\\d\{3\}\)/.test(src));

  // Fixture: sign the reference GET /fills prehash with FIXED temperature and pin
  // the exact prehash + an independently-recomputed signature.
  if (typeof (await import('../lib/providers/kraken-bitnomial.js')).signBtRequest === 'function') {
    const { signBtRequest } = await import('../lib/providers/kraken-bitnomial.js');
    const TS = '2026-10-14T12:00:00.000Z';
    const CONN = 'abc123';
    const TOKEN = '00'.repeat(32); // 64 hex chars, used AS utf8 bytes
    const PATH = '/exchange/api/v1/prod/fills/';
    const signed = signBtRequest({ method: 'GET', path: PATH, query: '', body: '', timestamp: TS, connectionId: CONN, authToken: TOKEN });
    const expectedPrehash = `GET${PATH}?BTNL-AUTH-TIMESTAMP${TS}BTNL-CONNECTION-ID${CONN}`;
    check('fixture: empty query → prehash carries a lone "?"', signed.prehash === expectedPrehash,
      `got ${JSON.stringify(signed.prehash)}`);
    const expectedSig = crypto.createHmac('sha256', TOKEN).update(expectedPrehash, 'utf8').digest('base64');
    check('fixture: signature = base64 HMAC-SHA256(prehash, token-as-utf8)', signed.signature === expectedSig);
    check('fixture: serialized headers are the three BTNL-* names, verbatim values',
      signed.headers['BTNL-AUTH-TIMESTAMP'] === TS &&
      signed.headers['BTNL-CONNECTION-ID'] === CONN &&
      signed.headers['BTNL-SIGNATURE'] === expectedSig);
    const two = signBtRequest({ method: 'GET', path: PATH, query: '', body: '', timestamp: TS, connectionId: CONN, authToken: TOKEN });
    check('fixture: HMAC is deterministic at a fixed temperature', two.signature === signed.signature);
    const q = signBtRequest({ method: 'GET', path: PATH, query: 'begin_time=1', body: '', timestamp: TS, connectionId: CONN, authToken: TOKEN });
    check('fixture: non-empty query is normalized to a leading "?"', q.prehash.includes(`${PATH}?begin_time=1`));
    const b = signBtRequest({ method: 'POST', path: PATH, query: '', body: { a: 1 }, timestamp: TS, connectionId: CONN, authToken: TOKEN });
    check('fixture: object body serialized then appended verbatim', b.prehash.endsWith('{"a":1}'));
  }

  // ── 3. Limiter wraps every fetch ─────────────────────────────────────────
  check('btRateLimiter is a shared singleton instance', /export const btRateLimiter = new BtRateLimiter\(/.test(src));
  check('the egress helper acquires a limiter slot FIRST', /await btRateLimiter\.acquire\(\)/.test(src));
  check('the egress helper resolves globalThis.fetch AT CALL TIME', /const doFetch = globalThis\.fetch;/.test(src));
  check('no raw fetch( call-expression in the provider (all egress via btFetch)',
    !/[^A-Za-z_.]fetch\(/.test(src.replace(/globalThis\.fetch/g, 'F').replace(/btFetch\(/g, 'B(').replace(/doFetch\(/g, 'D(')));
  check('200 req / 5 min bucket', /max\s*=\s*200/.test(src) && /5 \* 60 \* 1000/.test(src));

  // ── 4. Raw-Response + creds resolution ───────────────────────────────────
  check('btRequest returns the raw Response (no parsing)', /return await btFetch\(/.test(src));
  check("btRequest resolves creds via retrieveAPIKey(..., 'kraken')",
    /retrieveAPIKey\(\s*supabase\s*,\s*tenantId\s*,\s*'kraken'\s*\)/.test(src));
  check('provider imports retrieveAPIKey from secrets-manager',
    /import\s*\{[^}]*retrieveAPIKey[^}]*\}\s*from\s*'\.\.\/secrets-manager\.js'/.test(src));

  // ── 5. No Coinbase-isms ──────────────────────────────────────────────────
  check('NO `cross` param anywhere (coinbase-ism dropped)', !/\bcross\b/.test(src));

  // ── 7. Non-Coinbase host — the seam R2 rule cannot match it ───────────────
  check('provider host is bitnomial (not a Coinbase host)',
    /https:\/\/bitnomial\.com/.test(src) && !/coinbase\.com/.test(src));
}

// ── 6. Commit A INERT ↔ Commit B BOUND (the A→B switch) ─────────────────────
const providerImporters = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER) continue;
  const s = readFileSync(f, 'utf8');
  if (/kraken-bitnomial/.test(s)) providerImporters.push(file);
}
if (REPORT_ONLY) {
  check('INERT (Commit A): no behavior-bearing file imports the provider',
    providerImporters.length === 0,
    providerImporters.length ? `imported by: ${providerImporters.join(', ')}` : '');
} else {
  // Commit B: the provider is bound at every pricing seam it must own.
  const need = ['lib/execute-trade-mcp.js', 'workers/watchdog.js', 'pages/api/close-position.js'];
  const missing = need.filter((f) => !providerImporters.includes(f));
  check('BOUND (Commit B): provider imported by execute-trade + watchdog + close-position',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');
}

// ── 7b. R2-style: no bitnomial host fetch outside the provider ──────────────
// EXCEPTION: pages/api/available-assets.js is the Push 3 PUBLIC catalogue fetch
// (sanctioned, unauthenticated, untouched by this push). Behaviour/pricing files
// may only reach Bitnomial through the provider's exports.
const PUSH3_CATALOG = 'pages/api/available-assets.js';
const bitnomialOutside = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER || file === PUSH3_CATALOG) continue;
  const s = readFileSync(f, 'utf8');
  if (/bitnomial\.com/.test(s)) bitnomialOutside.push(file);
}
check('no bitnomial host reference outside the provider (Push 3 catalog excepted)',
  bitnomialOutside.length === 0,
  bitnomialOutside.length ? `found in: ${bitnomialOutside.join(', ')}` : '');

// ── 8. Commit B wiring (guarded) ────────────────────────────────────────────
const EXEC = 'lib/execute-trade-mcp.js';
if (exists(EXEC)) {
  const src = read(EXEC);
  check('execute-trade branches on exchange === \'kraken\'', /resolvedExchange\s*===\s*'kraken'/.test(src));
  check('execute-trade LIVE refuses loud with the exact [AM63] text',
    /\[AM63\] Kraken live execution arrives in Push 5 \(BTP order entry\)\. Venue runs paper-only until then\./.test(src));
  check('execute-trade kraken PAPER entry prices from getMarketStats (loud 502 if unknown)',
    /getMarketStats\(/.test(src) && /502/.test(src) && /kraken/i.test(src));
} else {
  check('execute-trade-mcp.js exists', false, EXEC + ' not found');
}

const WD = 'workers/watchdog.js';
if (exists(WD)) {
  const src = read(WD);
  check('watchdog branches kraken pricing (exchange === \'kraken\')', /\.exchange[\s\S]{0,60}===\s*'kraken'/.test(src));
  check('watchdog uses getMarketStats for the kraken mark', /getMarketStats\(/.test(src) && /mark_price/.test(src));
  check('watchdog loud [AM63] kraken stats unavailable (catch-and-continue)',
    /\[AM63\] kraken stats unavailable/.test(src));
  check('watchdog getAssetMetrics branches on venue (kraken contractSize)', /getAssetMetrics[\s\S]{0,400}kraken/.test(src));
} else {
  check('watchdog.js exists', false, WD + ' not found');
}

const RT = 'pages/api/reevaluate-trade.js';
if (exists(RT)) {
  const src = read(RT);
  check('reevaluate refuses loud for kraken BEFORE any fetch',
    /\[AM63\] reevaluate oracle unavailable for kraken \(no charts until venue OHLC\)/.test(src));
  const refuseAt = src.indexOf('[AM63] reevaluate oracle unavailable for kraken');
  const fetchAt = src.indexOf('fetchCoinbaseData(');
  check('reevaluate refuse precedes the Coinbase candle fetch', refuseAt > -1 && (fetchAt === -1 || refuseAt < fetchAt));
} else {
  check('reevaluate-trade.js exists', false, RT + ' not found');
}

const CP = 'pages/api/close-position.js';
if (exists(CP)) {
  const src = read(CP);
  check('close-position branches kraken → provider mark', /kraken/i.test(src) && /getMarketStats|resolveKrakenProduct/.test(src));
} else {
  check('close-position.js exists', false, CP + ' not found');
}

const RV = 'lib/risk-validator.js';
if (exists(RV)) {
  const src = read(RV);
  check('risk-validator assetSpecs carries the kraken contractSize', /kraken/i.test(src) && /contract_size|contractSize/.test(src));
} else {
  check('risk-validator.js exists', false, RV + ' not found');
}

const SP = 'workers/shadow-portfolio.js';
if (exists(SP)) {
  const src = read(SP);
  check('shadow-portfolio loud skip for kraken (Coinbase lane)',
    /\[AM63\]/.test(src) && /kraken/i.test(src) && /skip/i.test(src));
} else {
  check('shadow-portfolio.js exists', false, SP + ' not found');
}

// Router: accepts 'kraken', a real unknown STILL throws (widened allowlist = contract).
const ROUTER = 'lib/exchange-router.js';
if (exists(ROUTER)) {
  try {
    const mod = await import('../lib/exchange-router.js');
    // Runtime export inventory — a comment mentioning requireAdapterFor must not
    // trip this (the router doc explicitly says it does NOT exist).
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    check('router keeps exactly the two exports (no adapter binding added)',
      fns.length === 2 && fns[0] === 'assertExchangeSupported' && fns[1] === 'resolveExchange' &&
      typeof mod.requireAdapterFor === 'undefined',
      `found [${fns.join(', ')}]`);
    let krakenThrew = false, unknownThrew = false, coinbaseThrew = false;
    try { mod.assertExchangeSupported('kraken'); } catch { krakenThrew = true; }
    try { mod.assertExchangeSupported('bybit'); } catch { unknownThrew = true; }
    try { mod.assertExchangeSupported('coinbase'); } catch { coinbaseThrew = true; }
    check("assertExchangeSupported ACCEPTS 'kraken' (widened allowlist)", !krakenThrew);
    check("assertExchangeSupported STILL throws for a real unknown ('bybit')", unknownThrew && !coinbaseThrew);
  } catch (e) {
    check('exchange-router imports cleanly', false, e.message);
  }
} else {
  check('exchange-router.js exists', false, ROUTER + ' not found');
}

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 4 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
console.log('---------------');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`);
}
console.log('');

if (failed.length === 0) {
  console.log(`All ${results.length} checks passed.`);
  process.exit(0);
}

console.log(`${failed.length}/${results.length} check(s) FAILED.`);
if (REPORT_ONLY) {
  console.log('REPORT_ONLY=true → exiting 0. Commit B flips this gate to enforcing.');
  process.exit(0);
}
process.exit(1);
