// scripts/am68-check.mjs
// 🟢 AM68 GATE — Kraken SPOT (+ margin) lane, with the US-futures truth folded in.
//
// PART A (US-futures explicit — Commit A, ENFORCING):
//   1  The stale "Bitnomial live execution arrives in Push 8" string is ABSENT from
//      BOTH server routes; the truthful "Kraken has no US-futures API" string +
//      the `US_FUTURES_NO_KRAKEN_API` reason marker are present in BOTH.
//   2  subscribe-strategy comment names Tradovate (the real US-derivatives API route).
//   3  kraken-futures.js carries the US-ACCOUNT REALITY header (Tradovate + EXPECTED).
//   4  kraken-futures.js auth hint carries vector (4) ACCOUNT-LEVEL GEO-BLOCK.
//   5  kraken-fix.js header carries the VERDICT ADDENDUM (AM68).
//   6  MarketScanner VENUE_META kraken label reads "manual".
//   7  am64-check evolved (no stale Push 8 pin remains).
//   8  no-functional-change: Commit A did NOT add venue wiring to the server routes.
//
// PART B (spot lane):
//   Commit A (provider ships INERT — ENFORCING): the signing vector is byte-exact
//   against Kraken's published example; kraken-spot.js has NO Coinbase substitution,
//   a LOUD not-provisioned refusal, a rate limiter, and the TX/EUR margin note.
//   Commit B (guarded by REPORT_ONLY): the `krakenspot` literal reaches the router +
//   resolver + deploy + subscribe; `-SPOT-KRS` is stripped in normalizeVenueAssetId;
//   the vault venue is UPPERCASE KRAKENSPOT; the risk validator reads TradeBalance.
//
// REPORT_ONLY (Commit A): Commit B pins print but always exit 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am68-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(path.join(ROOT, rel));
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('AM68 Kraken SPOT + margin lane check' + (REPORT_ONLY ? ' (Commit A — Part B wiring guarded)' : '') + '\n');

const DEP = 'pages/api/deploy-strategy.js';
const SUB = 'pages/api/subscribe-strategy.js';
const KF = 'lib/providers/kraken-futures.js';
const KFIX = 'lib/providers/kraken-fix.js';
const MS = 'components/MarketScanner.js';
const SPOT = 'lib/providers/kraken-spot.js';
const ROUTER = 'lib/exchange-router.js';
const RESOLVER = 'lib/asset-resolver.js';
const RISK = 'lib/risk-validator.js';

// ══════════════════════ PART A — US-futures explicit ══════════════════════
console.log('── PART A — US-futures truth + copy ──');
{
  const src = read(DEP);
  check('A: deploy — stale "Push 8" string ABSENT', !/Bitnomial live execution arrives in Push 8/.test(src));
  check('A: deploy — truthful string present', /Kraken has no US-futures API/.test(src));
  check('A: deploy — US_FUTURES_NO_KRAKEN_API reason marker present', /US_FUTURES_NO_KRAKEN_API/.test(src));
  check('A: deploy — Tradovate named', /Tradovate/.test(src));
}
{
  const src = read(SUB);
  check('A: subscribe — stale "Push 8" string ABSENT', !/Bitnomial live execution arrives in Push 8/.test(src));
  check('A: subscribe — truthful string present', /Kraken has no US-futures API/.test(src));
  check('A: subscribe — US_FUTURES_NO_KRAKEN_API reason marker present', /US_FUTURES_NO_KRAKEN_API/.test(src));
  check('A: subscribe — Tradovate in the comment', /Tradovate/.test(src));
}
{
  const src = read(KF);
  check('A: kraken-futures header — US-ACCOUNT REALITY block', /US-ACCOUNT REALITY/.test(src));
  check('A: kraken-futures header — Tradovate named', /Tradovate/.test(src));
  check('A: kraken-futures header — EXPECTED (geo-block not a bug)', /EXPECTED/.test(src));
  check('A: auth hint — vector (4) ACCOUNT-LEVEL GEO-BLOCK',
    /ACCOUNT-LEVEL GEO-BLOCK/.test(src) && /KDUS/.test(src));
}
{
  const src = read(KFIX);
  check('A: kraken-fix header — VERDICT ADDENDUM present', /VERDICT ADDENDUM/.test(src));
}
{
  const src = read(MS);
  check('A: VENUE_META kraken label reads "manual"', /Kraken US \(Bitnomial · manual\)/.test(src));
}
{
  const src = read('scripts/am64-check.mjs');
  check('A: am64-check evolved — no stale Push 8 pin remains', !/Bitnomial live execution arrives in Push 8/.test(src));
  check('A: am64-check pins the new string', /Kraken has no US-futures API/.test(src));
}
{
  // No-functional-change: Commit A must NOT have added venue wiring to the routes.
  const depSrc = read(DEP);
  const subSrc = read(SUB);
  if (REPORT_ONLY) {
    check('A: no-functional-change — krakenspot NOT yet in deploy allowlist',
      !/KNOWN_EXCHANGES\s*=\s*\[[^\]]*'krakenspot'/.test(depSrc));
    check('A: no-functional-change — krakenspot NOT yet in subscribe gate',
      !/krakenspot/.test(subSrc));
  } else {
    check('B: deploy allowlist widened with krakenspot',
      /KNOWN_EXCHANGES\s*=\s*\[[^\]]*'krakenspot'/.test(depSrc));
    check('B: subscribe gate handles krakenspot', /krakenspot/.test(subSrc));
  }
}

// ══════════════════════ PART B — spot provider (Commit A) ══════════════════
console.log('\n── PART B — kraken-spot.js provider (inert) ──');
check('B: lib/providers/kraken-spot.js exists', exists(SPOT));
if (exists(SPOT)) {
  const raw = read(SPOT);
  const code = stripComments(raw);

  // Signing vector — byte-exact against Kraken's published example.
  let signOk = false;
  let signDetail = '';
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, SPOT)).href);
    const SECRET = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    const NONCE = '1616492376594';
    const BODY = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
    const EXPECTED = '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==';
    const got = mod.krSpotSign('/0/private/AddOrder', NONCE, BODY, SECRET);
    signOk = got === EXPECTED;
    signDetail = signOk ? '' : `got ${got}`;
  } catch (e) {
    signDetail = e.message;
  }
  check('B: signing vector byte-exact vs Kraken docs example (Node == expected API-Sign)', signOk, signDetail);

  check('B: binary-safe concat (Buffer.concat), not string concat', /Buffer\.concat\(\[Buffer\.from\([^)]*uriPath/.test(code));
  check('B: NO Coinbase substitution in code (no cbRequest / generateCoinbaseToken / api.coinbase.com)',
    !/cbRequest|generateCoinbaseToken|api\.coinbase\.com/.test(code));
  check('B: LOUD not-provisioned refusal (never silent)', /Kraken SPOT not provisioned/.test(raw));
  check('B: rate limiter present', /KrSpotRateLimiter/.test(raw) && /krSpotRateLimiter/.test(raw));
  check('B: AddOrder wrapper carries the leverage param (margin ON)', /params\.leverage\s*=/.test(code));
  check('B: settle-position closes honored (or opposite-side fallback documented)', /settle-position/.test(raw));
  check('B: TX/EUR margin note — quote=EUR marked margin-ineligible', /marginEligible|!== 'EUR'/.test(code));
  check('B: native symbol is the Kraken altname (XBTUSD stays intact)', /nativeSymbol/.test(code) && /XBT/.test(raw));
  check('B: creds resolve INSIDE via retrieveAPIKey(..., \'krakenspot\')',
    /retrieveAPIKey\(supabase,\s*tenantId,\s*'krakenspot'\)/.test(code));
  check('B: TX/EUR + TradeBalance equity surface exists', /getKrakenSpotTradeBalance/.test(code));
  check('B: OpenPositions margin watchdog surface exists', /getKrakenSpotOpenPositions/.test(code));
}

// ══════════════════════ PART B — venue wiring (Commit B) ═══════════════════
console.log('\n── PART B — venue wiring (Commit B, guarded) ──');
if (!REPORT_ONLY) {
  const router = read(ROUTER);
  check('B: router admits kraken (allowlist branch)', /'krakenspot'/.test(router));
  const resolver = read(RESOLVER);
  check('B: normalizeVenueAssetId strips -SPOT-KRS', /-SPOT-KRS/.test(resolver));
  const dep = read(DEP);
  check('B: deploy vaultVenue reaches KRAKENSPOT', /KRAKENSPOT/.test(dep));
  const sub = read(SUB);
  check('B: subscribe vaultVenue reaches KRAKENSPOT', /KRAKENSPOT/.test(sub));
  const risk = read(RISK);
  check('B: risk-validator reads the spot TradeBalance (margin equity, not just spot)',
    /krakenspot/.test(risk) && /getKrakenSpotTradeBalance|TradeBalance/.test(risk));
  check('B: settings exposes the KRAKENSPOT vault option', /KRAKENSPOT/.test(read('pages/settings.js')));
} else {
  check('B (guarded): router kraken-literal pin — deferred to Commit B', true);
  check('B (guarded): resolver -SPOT-KRS strip — deferred to Commit B', true);
  check('B (guarded): deploy/subscribe KRAKENSPOT vault venue — deferred to Commit B', true);
  check('B (guarded): risk-validator TradeBalance — deferred to Commit B', true);
}

// ─────────────────────────────────── report ────────────────────────────────
console.log(`\nAM68 check: ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error(`AM68 check: ${fail} FAILURE(S): ${failures.join('; ')}`);
  if (REPORT_ONLY) {
    console.log('REPORT_ONLY=true → exiting 0 (Commit A). Commit B flips this gate to enforcing.');
    process.exit(0);
  }
  process.exit(1);
}
process.exit(0);
