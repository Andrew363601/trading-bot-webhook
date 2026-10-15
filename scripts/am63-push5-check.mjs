// scripts/am63-push5-check.mjs
// 🟢 PUSH AM63 (Push 5) GATE — Kraken Futures (apiv3) + the dashboard matrix.
//
// Enforces the Push 5 contract:
//   1  lib/providers/kraken-futures.js exists with the pinned exports.
//   2  Host exclusivity: futures.kraken.com appears ONLY in the provider (+ the
//      sanctioned public catalog fetch); a demo override knob exists.
//   3  NO credentials in the provider (public-only until Push 6).
//   4  The budgeted limiter wraps EVERY Kraken Futures fetch; shared singleton.
//   5  kfRequest returns the RAW fetch Response.
//   6  Cache TTLs (tickers ≥15 s, instruments ≥1 h).
//   7  id pattern `${BASE}-PERP-KRF` — NO size suffix (apiv3 has one perp per base).
//   8  base normalization XBT→BTC.
//   9  Commit A is INERT — no behavior-bearing file imports the provider.
//  10  Commit B (guarded by REPORT_ONLY): catalog branch (+ price≠0 for KRF),
//      router allowlist (3 venues; 'bybit' still throws), execute-trade lane
//      (paper mark entry, tick from instrument, live refusal text), watchdog +
//      chart route + reevaluate branch, MarketScanner venue wiring + stale-race +
//      favorites-venue + deploy exchange carry, migration 062 shape.
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push5-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'scripts']);

const PROVIDER = 'lib/providers/kraken-futures.js';
const PUSH5_CATALOG = 'pages/api/available-assets.js';

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
  check('kraken-futures.js provider exists', false, PROVIDER + ' not found');
} else {
  let mod = null;
  try {
    mod = await import('../lib/providers/kraken-futures.js');
    check('provider imports cleanly', true);
  } catch (e) {
    check('provider imports cleanly', false, e.message);
  }
  if (mod) {
    check('provider exports kfRequest', typeof mod.kfRequest === 'function');
    check('provider exports getKrakenTickers', typeof mod.getKrakenTickers === 'function');
    check('provider exports resolveKrakenFuturesProduct', typeof mod.resolveKrakenFuturesProduct === 'function');
    check('provider exports KfRateLimiter class', typeof mod.KfRateLimiter === 'function');
    check('provider exports a shared kfRateLimiter instance', !!mod.kfRateLimiter && typeof mod.kfRateLimiter.acquire === 'function');
    check('provider exports KF_HOST', typeof mod.KF_HOST === 'string' && /^https?:\/\//.test(mod.KF_HOST));
  }
}

// ── 2/3/4/5/6/7/8. Static pins ──────────────────────────────────────────────
if (exists(PROVIDER)) {
  const src = read(PROVIDER);
  check('provider host is futures.kraken.com', /https:\/\/futures\.kraken\.com/.test(src));
  check('provider has a demo host override knob', /demo-futures\.kraken\.com/.test(src) && /KRAKEN_FUTURES_(HOST|DEMO)/.test(src));
  // Strip comments first — the header legitimately DOCUMENTS the Push 6 HMAC layer,
  // so a raw scan would false-positive on the word "HMAC-SHA512"/"Authent".
  const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('provider has NO credentials (public-only until Push 6)',
    !/retrieveAPIKey|apiSecret|apiKey|createHmac|Authent/i.test(srcCode));
  check('provider documents the Push 6 private layer as out of scope',
    /Push 6/.test(src) && /sendorder|HMAC-SHA512/.test(src));
  check('kfRateLimiter is a shared singleton instance', /export const kfRateLimiter = new KfRateLimiter\(/.test(src));
  check('the egress helper acquires a limiter slot FIRST', /await kfRateLimiter\.acquire\(\)/.test(src));
  check('the egress helper resolves globalThis.fetch AT CALL TIME', /const doFetch = globalThis\.fetch;/.test(src));
  check('no raw fetch( call-expression in the provider (all egress via kfFetch)',
    !/[^A-Za-z_.]fetch\(/.test(src.replace(/globalThis\.fetch/g, 'F').replace(/kfFetch\(/g, 'K(').replace(/doFetch\(/g, 'D(')));
  check('500 / 10 s cost budget', /max\s*=\s*500/.test(src) && /10 \* 1000/.test(src));
  check('kfRequest returns the raw Response (no parsing)', /return await kfFetch\(/.test(src));
  check('tickers cache TTL ≥15 s', /TICKERS_TTL_MS\s*=\s*15 \* 1000/.test(src));
  check('instruments cache TTL ≥1 h', /INSTRUMENTS_TTL_MS\s*=\s*60 \* 60 \* 1000/.test(src));
  check('id pattern `${base}-PERP-KRF` with NO size suffix', /`\$\{base\}-PERP-KRF`/.test(src));
  check('PF_ filter + tradeable/suspended/isExpired guards',
    /startsWith\('PF_'\)/.test(src) && /tradeable/.test(src) && /suspended/.test(src) && /isExpired/.test(src));
  check('base normalization XBT→BTC', /XBT/.test(src) && /BTC/.test(src));
  check('markPrice primary with last fallback', /markPrice/.test(src) && /last/.test(src));
  check('indexPrice mapped defensively (optional)', /indexPrice/.test(src));
}

// ── 9. Commit A INERT ↔ Commit B BOUND (the A→B switch) ─────────────────────
const providerImporters = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER) continue;
  const s = readFileSync(f, 'utf8');
  if (/kraken-futures/.test(s)) providerImporters.push(file);
}
if (REPORT_ONLY) {
  check('INERT (Commit A): no behavior-bearing file imports the provider',
    providerImporters.length === 0,
    providerImporters.length ? `imported by: ${providerImporters.join(', ')}` : '');
} else {
  const need = ['lib/execute-trade-mcp.js', 'workers/watchdog.js', 'pages/api/close-position.js'];
  const missing = need.filter((f) => !providerImporters.includes(f));
  check('BOUND (Commit B): provider imported by execute-trade + watchdog + close-position',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');
}

// ── 2b. Host exclusivity: futures.kraken.com only in provider + catalog ─────
const kfHostOutside = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER || file === PUSH5_CATALOG) continue;
  const s = readFileSync(f, 'utf8');
  if (/futures\.kraken\.com/.test(s)) kfHostOutside.push(file);
}
check('no futures.kraken.com reference outside the provider (catalog excepted)',
  kfHostOutside.length === 0,
  kfHostOutside.length ? `found in: ${kfHostOutside.join(', ')}` : '');

// ── 10. Commit B wiring (guarded) ───────────────────────────────────────────
const CATALOG = PUSH5_CATALOG;
if (exists(CATALOG)) {
  const src = read(CATALOG);
  check("catalog branches on exchange === 'krakenfutures'", /krakenfutures/.test(src));
  check('catalog KRF branch carries a real price (markPrice, not 0)',
    /markPrice/.test(src) && /-PERP-KRF/.test(src));
  // Freshness: the KRF branch reads the provider's short-TTL caches (15 s tickers)
  // rather than pinning a long Next revalidate — fresher than the 60 s decision.
  check('catalog KRF branch relies on the provider for fresh marks',
    /getKrakenInstruments|getKrakenTickers/.test(src));
} else {
  check('available-assets.js exists', false, CATALOG + ' not found');
}

const EXEC = 'lib/execute-trade-mcp.js';
if (exists(EXEC)) {
  const src = read(EXEC);
  check("execute-trade branches on exchange === 'krakenfutures'", /krakenfutures/.test(src));
  // Strip comments first — the explanatory comment legitimately mentions the WRONG
  // form (`-PERP-KRF-`) to warn against it, which would false-trip the negative.
  const execCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('execute-trade detects the KRF id WITHOUT a trailing dash',
    /includes\('-PERP-KRF'\)/.test(execCode) && !/includes\('-PERP-KRF-'\)/.test(execCode));
  check('execute-trade LIVE refuses loud with the exact [AM63] text',
    /\[AM63\] Kraken Futures live execution arrives in Push 6 \(apiv3 sendorder\)\. Venue runs paper-only until then\./.test(src));
  check('execute-trade KRF PAPER entry prices from getKrakenTickers (loud 502 if unknown)',
    /getKrakenTickers\(/.test(src) && /502/.test(src));
  check('execute-trade KRF tick comes from the instrument (not a coinbase default)',
    /tickSize/.test(src) && /resolveKrakenFuturesProduct/.test(src));
} else {
  check('execute-trade-mcp.js exists', false, EXEC + ' not found');
}

const WD = 'workers/watchdog.js';
if (exists(WD)) {
  const src = read(WD);
  check("watchdog branches krakenfutures pricing", /krakenfutures/.test(src));
  check('watchdog uses getKrakenTickers for the KRF mark', /getKrakenTickers\(/.test(src));
  check('watchdog loud [AM63] KRF stats unavailable (catch-and-continue)',
    /KRF_STATS_UNAVAILABLE/.test(src));
  check('watchdog getAssetMetrics branches on venue (KRF tickSize/contractSize)',
    /getAssetMetrics[\s\S]{0,600}krakenfutures/.test(src));
} else {
  check('watchdog.js exists', false, WD + ' not found');
}

const CP = 'pages/api/close-position.js';
if (exists(CP)) {
  const src = read(CP);
  check('close-position branches krakenfutures → provider mark',
    /krakenfutures/.test(src) && /getKrakenTickers|resolveKrakenFuturesProduct/.test(src));
} else {
  check('close-position.js exists', false, CP + ' not found');
}

const CANDLES = 'lib/candles.js';
if (exists(CANDLES)) {
  const src = read(CANDLES);
  check('candle bridge routes -PERP-KRF ids to the Kraken Futures charts backend',
    /-PERP-KRF/.test(src) && /charts\/v1\/trade/.test(src));
  check('candle bridge converts ms→sec and string→float',
    /1000/.test(src) && /parseFloat/.test(src));
} else {
  check('candles.js exists', false, CANDLES + ' not found');
}

const CHART = 'pages/api/chart-data.js';
if (exists(CHART)) {
  const src = read(CHART);
  check('chart-data routes -PERP-KRF ids to the KRF backend', /-PERP-KRF/.test(src));
} else {
  check('chart-data.js exists', false, CHART + ' not found');
}

const RT = 'pages/api/reevaluate-trade.js';
if (exists(RT)) {
  const src = read(RT);
  check('reevaluate handles krakenfutures (probe-gated oracle or loud refuse)',
    /krakenfutures/.test(src));
} else {
  check('reevaluate-trade.js exists', false, RT + ' not found');
}

const SP = 'workers/shadow-portfolio.js';
if (exists(SP)) {
  const src = read(SP);
  check('shadow-portfolio loud skip for krakenfutures (Coinbase lane)',
    /-PERP-KRF/.test(src) && /skip/i.test(src));
} else {
  check('shadow-portfolio.js exists', false, SP + ' not found');
}

const MS = 'components/MarketScanner.js';
if (exists(MS)) {
  const src = read(MS);
  check('MarketScanner has a venue select (krakenfutures option)', /krakenfutures/.test(src));
  check('MarketScanner matrix fetch honors ?exchange=', /available-assets\?exchange=/.test(src));
  check('MarketScanner uses a venue-keyed stale-race guard', /fetchedVenueRef/.test(src));
  check('MarketScanner deploy POST carries exchange: venue', /exchange:\s*venue|exchange:\s*assetExchange/.test(src));
  check('MarketScanner favorites are venue-scoped', /venue/.test(src) && /favorite_assets/.test(src));
} else {
  check('MarketScanner.js exists', false, MS + ' not found');
}

const STUDIO = 'pages/studio.js';
if (exists(STUDIO)) {
  const src = read(STUDIO);
  check('Studio venue select gains the Kraken Futures option', /krakenfutures/.test(src));
} else {
  check('studio.js exists', false, STUDIO + ' not found');
}

const SETTINGS = 'pages/settings.js';
if (exists(SETTINGS)) {
  const src = read(SETTINGS);
  check('settings vault gains the KRAKENFUTURES option', /KRAKENFUTURES/.test(src));
} else {
  check('settings.js exists', false, SETTINGS + ' not found');
}

const DEPLOY = 'pages/api/deploy-strategy.js';
if (exists(DEPLOY)) {
  const src = read(DEPLOY);
  check("deploy-strategy allowlist widened to include 'krakenfutures'",
    /KNOWN_EXCHANGES\s*=\s*\[[^\]]*'krakenfutures'/.test(src));
} else {
  check('deploy-strategy.js exists', false, DEPLOY + ' not found');
}

// Sniper venue lane (Push 5 fix): KRF REST polling + KRX loud skip.
const SNIPER = 'workers/sniper.js';
if (exists(SNIPER)) {
  const src = read(SNIPER);
  check('sniper imports the KRF provider + candle bridge',
    /providers\/kraken-futures\.js/.test(src) && /from '\.\.\/lib\/candles\.js'/.test(src));
  check('sniper has a KRF REST lane (getKrakenTickers, NO WebSocket)',
    /getKrakenTickers\(/.test(src) && /kfPoll/.test(src));
  check('sniper KRF candles route through the shared bridge (fetchCandles)',
    /fetchCandles\(\{ product: asset/.test(src));
  check('sniper skips Bitnomial (KRX) ids LOUD (no scanner data)',
    /no scanner data for Bitnomial ids yet/.test(src) && /KRAKEN_NO_SCANNER_DATA/.test(src));
  check('sniper KRF lane is additive (Coinbase path byte-identical)',
    /fetchCoinbaseData\(config\.asset, tf, apiKeyName, apiSecret\)/.test(src));
} else {
  check('sniper.js exists', false, SNIPER + ' not found');
}

// Migration 062 shape.
const MIG = 'supabase/migrations/062-favorites-venue.sql';
if (exists(MIG)) {
  const src = read(MIG);
  check('062 adds a venue column to favorite_assets',
    /alter table favorite_assets[\s\S]{0,120}add column if not exists venue/.test(src));
  check('062 venue column is NOT NULL DEFAULT \'coinbase\'',
    /not null default 'coinbase'/.test(src));
} else {
  check('062-favorites-venue.sql exists', false, MIG + ' not found');
}

// Router: accepts 'krakenfutures', a real unknown STILL throws.
const ROUTER = 'lib/exchange-router.js';
if (exists(ROUTER)) {
  try {
    const mod = await import('../lib/exchange-router.js');
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    check('router keeps exactly the two exports (no adapter binding added)',
      fns.length === 2 && fns[0] === 'assertExchangeSupported' && fns[1] === 'resolveExchange' &&
      typeof mod.requireAdapterFor === 'undefined',
      `found [${fns.join(', ')}]`);
    let kfThrew = false, unknownThrew = false, coinbaseThrew = false;
    try { mod.assertExchangeSupported('krakenfutures'); } catch { kfThrew = true; }
    try { mod.assertExchangeSupported('bybit'); } catch { unknownThrew = true; }
    try { mod.assertExchangeSupported('coinbase'); } catch { coinbaseThrew = true; }
    check("assertExchangeSupported ACCEPTS 'krakenfutures' (widened allowlist)", !kfThrew);
    check("assertExchangeSupported STILL throws for a real unknown ('bybit')", unknownThrew && !coinbaseThrew);
  } catch (e) {
    check('exchange-router imports cleanly', false, e.message);
  }
} else {
  check('exchange-router.js exists', false, ROUTER + ' not found');
}

// ── 11. Prior-push invariants intact ────────────────────────────────────────
const KRX_PROVIDER = 'lib/providers/kraken-bitnomial.js';
if (exists(KRX_PROVIDER)) {
  const src = read(KRX_PROVIDER);
  check('push4 KRX door untouched (bitnomial host + resolveKrakenProduct intact)',
    /https:\/\/bitnomial\.com/.test(src) && /export async function resolveKrakenProduct/.test(src));
}

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 5 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
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
