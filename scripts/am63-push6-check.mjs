// scripts/am63-push6-check.mjs
// 🟢 PUSH AM63 (Push 6) GATE — Telemetry Parity (the brain gets eyes).
//
// Enforces the Push 6 contract:
//   1  lib/providers/kraken-futures.js gains getKrakenOrderBook (RAW Response,
//      QUERY-PARAM form — the path-segment form is pinned ABSENT) + the PURE
//      summarizeKrakenBook (spec shape: spread/imbalance/bids_50_levels/
//      asks_50_levels/largest_bid_walls/largest_ask_walls).
//   2  lib/asset-resolver.js gains the PURE normalizeVenueAssetId (venue-id → base
//      symbol; CDE codes KEPT — the CDE→base rewrite stays at its own seams).
//   3  Commit A is INERT — no behavior-bearing file consumes the new symbols yet.
//   4  Commit B (guarded by REPORT_ONLY): get-market-state-mcp.js KRF branch (real
//      venue candles + real book, NO Coinbase hosts in the branch region) + KRX
//      marks-only honest-dark branch (exact reason string); get-atr-levels-mcp.js
//      KRF venue-ATR via the candle bridge + KRX loud refusal (exact string);
//      Coinglass normalization at the gateway (BOTH strip sites) + the indicator
//      route; sniper honest-zero book literal ABSENT + real book wiring.
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push6-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
const REPORT_ONLY = true;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'scripts']);

const PROVIDER = 'lib/providers/kraken-futures.js';
const RESOLVER = 'lib/asset-resolver.js';
const MARKET_STATE = 'lib/get-market-state-mcp.js';
const ATR = 'lib/get-atr-levels-mcp.js';
const GATEWAY = 'mcp-gateway.js';
const CG_ROUTE = 'pages/api/coinglass-indicator.js';
const SNIPER = 'workers/sniper.js';

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

// ── 1. Provider: orderbook door + pure summarizer (behavioural import) ──────
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
    check('provider exports getKrakenOrderBook', typeof mod.getKrakenOrderBook === 'function');
    check('provider exports summarizeKrakenBook (PURE)', typeof mod.summarizeKrakenBook === 'function');
    // Behavioral fixture: the summarizer must produce the spec shape from tuple arrays.
    try {
      const s = mod.summarizeKrakenBook(
        { bids: [['100.0', '10'], ['99.0', '30']], asks: [['101.0', '5'], ['102.0', '20']] },
        { topN: 2, levelsN: 50 }
      );
      check('summarizeKrakenBook returns the spec shape',
        s && typeof s.spread === 'number'
        && (s.imbalance === 'BULLISH' || s.imbalance === 'BEARISH')
        && typeof s.bids_50_levels === 'string' && typeof s.asks_50_levels === 'string'
        && Array.isArray(s.largest_bid_walls) && Array.isArray(s.largest_ask_walls)
        && s.largest_bid_walls.every((w) => typeof w.price === 'number' && typeof w.size === 'number'),
        JSON.stringify(s));
      check('summarizeKrakenBook spread is bestAsk − bestBid (positive on a normal book)',
        s.spread > 0, `spread=${s.spread}`);
      check('summarizeKrakenBook walls are top-by-size DESC',
        s.largest_bid_walls[0]?.size === 30 && s.largest_ask_walls[0]?.size === 20,
        JSON.stringify(s.largest_bid_walls));
      check('summarizeKrakenBook depth totals are .toFixed(2) strings',
        s.bids_50_levels === '40.00' && s.asks_50_levels === '25.00',
        `${s.bids_50_levels}/${s.asks_50_levels}`);
      const e = mod.summarizeKrakenBook({ bids: [], asks: [] });
      check('summarizeKrakenBook degrades honestly on an empty book',
        e.spread === 0 && e.bids_50_levels === '0.00' && e.asks_50_levels === '0.00'
        && e.largest_bid_walls.length === 0 && e.largest_ask_walls.length === 0,
        JSON.stringify(e));
    } catch (e) {
      check('summarizeKrakenBook behavioral fixture', false, e.message);
    }
  }

  const src = read(PROVIDER);
  // Comment-stripped source for negative pins — the header legitimately DOCUMENTS the
  // wrong forms (the 404ing path-segment shape) as probe receipts.
  const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // QUERY-PARAM form pinned; the path-segment form pinned ABSENT (it 404s live).
  check('orderbook uses the QUERY-PARAM form (?symbol=…)',
    /query:\s*`symbol=\$\{encodeURIComponent\(sym\)\}`/.test(srcCode));
  check('orderbook path-segment form is ABSENT (it 404s live)',
    !/orderbook\/\$\{|orderbook\/PF_/.test(srcCode));
  check('getKrakenOrderBook returns the RAW Response (no parsing inside)',
    /return kfRequest\(\{ path: ORDERBOOK_PATH/.test(srcCode));
  check('orderbook sends NO limit param (only symbol= is probe-pinned)',
    !/limit=/.test(srcCode));
  check('orderbook has NO cache (the book is hot)', !/orderbookCache/.test(src));
  check('summarizeKrakenBook is PURE (no fetch/kfRequest/limiter in its body)',
    (() => {
      const m = src.match(/export function summarizeKrakenBook[\s\S]*?\n\}/);
      return !!m && !/kfRequest|kfFetch|await |fetch\(/.test(m[0]);
    })());
}

// ── 2. Resolver: the PURE venue-id normalizer (behavioural import) ──────────
if (!exists(RESOLVER)) {
  check('asset-resolver.js exists', false, RESOLVER + ' not found');
} else {
  let mod = null;
  try {
    mod = await import('../lib/asset-resolver.js');
    check('asset-resolver imports cleanly', true);
  } catch (e) {
    check('asset-resolver imports cleanly', false, e.message);
  }
  if (mod) {
    check('resolver exports normalizeVenueAssetId (PURE)', typeof mod.normalizeVenueAssetId === 'function');
    const units = [
      ['BTC-PERP-KRF', 'BTC'],
      ['DOGE-PERP-KRX-5000', 'DOGE'],
      ['XRP-PERP-KRX-0.01', 'XRP'],
      ['ETP-20DEC30-CDE', 'ETP'],
      ['BTC-PERP-INTX', 'BTC'],
      ['ETH-PERP', 'ETH'],
      ['BTC', 'BTC'],
      ['xrp-perp-krf', 'XRP'],
      ['', ''],
    ];
    let bad = [];
    for (const [i, want] of units) {
      const got = mod.normalizeVenueAssetId(i);
      if (got !== want) bad.push(`${JSON.stringify(i)}→${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
    }
    check('normalizeVenueAssetId gate units (KRF/KRX/CDE/INTX/bare)', bad.length === 0, bad.join('; '));
  }
  const rsrc = read(RESOLVER);
  check('normalizer keeps CDE codes (no ETP→ETH rewrite in the resolver)',
    !/ETP['"]?\s*[:=]\s*['"]?ETH/.test(rsrc));
}

// ── 3. Commit A INERT ↔ Commit B BOUND (the A→B switch) ─────────────────────
const NEW_SYMBOLS = /getKrakenOrderBook|summarizeKrakenBook|normalizeVenueAssetId/;
const consumers = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER || file === RESOLVER) continue;
  const s = readFileSync(f, 'utf8');
  if (NEW_SYMBOLS.test(s)) consumers.push(file);
}
if (REPORT_ONLY) {
  check('INERT (Commit A): no behavior-bearing file consumes the new symbols',
    consumers.length === 0,
    consumers.length ? `consumed by: ${consumers.join(', ')}` : '');
} else {
  const need = {
    [MARKET_STATE]: 'get-market-state',
    [ATR]: 'atr-levels',
    [GATEWAY]: 'mcp-gateway',
    [CG_ROUTE]: 'coinglass route',
    [SNIPER]: 'sniper',
  };
  const missing = Object.keys(need).filter((f) => !consumers.includes(f));
  check('BOUND (Commit B): all five seams consume the new symbols',
    missing.length === 0,
    missing.length ? `missing: ${missing.map((f) => need[f]).join(', ')}` : '');
}

// ── 4. Commit B wiring (guarded) ────────────────────────────────────────────
if (!REPORT_ONLY) {
  if (exists(MARKET_STATE)) {
    const src = read(MARKET_STATE);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('market-state branches BEFORE any Coinbase fetch (KRF + KRX)',
      /-PERP-KRF/.test(code) && /-PERP-KRX-/.test(code));
    check('market-state KRF branch uses the venue provider (tickers + book)',
      /getKrakenTickers\(/.test(code) && /getKrakenOrderBook\(/.test(code)
      && /summarizeKrakenBook\(/.test(code) && /resolveKrakenFuturesProduct\(/.test(code));
    check('market-state KRF candles come from the shared bridge (fetchCandles)',
      /fetchCandles\(/.test(code));
    // No-Coinbase-hosts-in-KRF-branches: slice the KRF branch region and assert the
    // Coinbase brokerage surface never appears inside it.
    const krfIdx = code.indexOf('-PERP-KRF');
    const coinbaseIdx = code.indexOf('fetchCoinbaseData');
    const krfRegion = krfIdx !== -1 && coinbaseIdx > krfIdx ? code.slice(krfIdx, coinbaseIdx) : code.slice(krfIdx);
    check('market-state KRF branch region has NO Coinbase brokerage surface',
      krfIdx === -1 || !/brokerage|generateCoinbaseToken|cbRequest/.test(krfRegion));
    check('market-state KRX marks come from getMarketStats (mark_price primary)',
      /getMarketStats\(/.test(code) && /mark_price/.test(code));
    check('market-state KRX honest-dark book reason is pinned EXACTLY',
      /Bitnomial book arrives with the market-data push/.test(src));
    check('market-state KRX never fabricates a zero-walls valid read',
      !/largest_bid_walls:\s*\[\]/.test(code.slice(code.indexOf('-PERP-KRX-'))));
    check('market-state documents the parity map in a comment',
      /PARITY MAP/i.test(src));
  } else {
    check('get-market-state-mcp.js exists', false, MARKET_STATE + ' not found');
  }

  if (exists(ATR)) {
    const src = read(ATR);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('atr-levels refuses KRX ids LOUD before any fetch (exact string)',
      /ATR unavailable for Bitnomial ids \(no venue OHLC until the market-data push\)/.test(src));
    check('atr-levels KRF candles come from the shared bridge (fetchCandles)',
      /fetchCandles\(/.test(code));
    check('atr-levels keeps the Coinbase path (fetchCoinbaseData still present)',
      /fetchCoinbaseData\(/.test(code));
  } else {
    check('get-atr-levels-mcp.js exists', false, ATR + ' not found');
  }

  if (exists(GATEWAY)) {
    const src = read(GATEWAY);
    check('gateway routes Coinglass asset args through normalizeVenueAssetId',
      /normalizeVenueAssetId/.test(src));
    check('gateway keeps the CDE→base rewrite AFTER the venue strip',
      /CDE_TO_BASE\[/.test(src));
    check('gateway keeps the USDT append guard', /includes\('USDT'\)/.test(src));
  } else {
    check('mcp-gateway.js exists', false, GATEWAY + ' not found');
  }

  if (exists(CG_ROUTE)) {
    const src = read(CG_ROUTE);
    check('coinglass route normalizes venue ids via the shared normalizer',
      /normalizeVenueAssetId/.test(src));
    check('coinglass route keeps FUTURES_CODE_MAP (CDE rewrite stays)',
      /FUTURES_CODE_MAP/.test(src));
  } else {
    check('coinglass-indicator route exists', false, CG_ROUTE + ' not found');
  }

  if (exists(SNIPER)) {
    const src = read(SNIPER);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('sniper KRF book is REAL (getKrakenOrderBook + summarizeKrakenBook)',
      /getKrakenOrderBook\(/.test(code) && /summarizeKrakenBook\(/.test(code));
    check('sniper honest-zero book literal is ABSENT',
      !/Unavailable \(Kraken Futures — no book this push\)/.test(src));
    check('sniper keeps the try/catch degrade-to-empty on book failure',
      /KRF microstructure failed/.test(src));
  } else {
    check('sniper.js exists', false, SNIPER + ' not found');
  }
}

// ── 5. Prior-push invariants intact ─────────────────────────────────────────
const PUSH5 = 'scripts/am63-push5-check.mjs';
if (exists(PUSH5)) {
  const src = read(PUSH5);
  // The gate file stores these as regex LITERALS (getKrakenTickers\( ) — match the
  // symbol text, not the call form.
  check('push5 gate still pins the sniper KRF lane (un-evolved)',
    /kfPoll/.test(src) && /getKrakenTickers/.test(src));
}

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 6 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
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
