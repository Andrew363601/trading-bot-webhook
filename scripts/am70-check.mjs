// scripts/am70-check.mjs
// 🟢 AM70 GATE — STRATEGY CARD TRUTH + DEPLOY-PANEL/MATRIX CLEANUP.
//
// PART A (execution truth + venue identity):
//   1  lib/venue-meta.js exists; VENUE_META (4 keys) + venueFromAssetId exported.
//   2  venueFromAssetId is PURE and resolves all four suffix families (BEHAVIORAL
//      VECTOR via dynamic import) — unknown → null (loud-absent, never a guess).
//   3  MarketScanner imports the shared map (no duplicated literal VENUE_META).
//   4  The strategy card renders a venue badge + the FULL asset id.
//   5  The card carries a granular strip (honest-absent) + Borrowing chips that
//      POST subscribe-strategy and render rejects as a toast.
//   6  The scanner asset list is sub-grouped by venue (VENUE_META headers).
//
// PART B (deploy-panel + matrix cleanup):
//   7  ONE qty box: the legacy `__notional_qty__` input is GONE (strip display-only).
//   8  No `setStrategyParams({})` in the subscribe SUCCESS path (qty no longer reverts).
//   9  Deployed-readback binding present (panel binds to the persisted config).
//  10  `product_type` is venue-conditional (no bare 'FUTURES' literal in the body).
//  11  `setShowScanner(false)` is GONE from the index select handler (sticky matrix).
//  12  Lifted venue + selection state (reopen restores context).
//
// Read-only; never mutates the repo. Run: node scripts/am70-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(path.join(ROOT, rel));
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
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

const VMETA = 'lib/venue-meta.js';
const SCANNER = 'components/MarketScanner.js';
const INDEX = 'pages/index.js';

console.log('AM70 strategy card truth + deploy-panel/matrix cleanup check\n');

// ═══════════════════ 1. lib/venue-meta.js (shared identity) ═══════════════════
console.log('── 1. lib/venue-meta.js (single source of venue identity) ──');
check('module exists', exists(VMETA));
if (exists(VMETA)) {
  const raw = read(VMETA);
  check('VENUE_META exported', /export const VENUE_META/.test(raw));
  check('all four venue keys present',
    /coinbase:/.test(raw) && /kraken:/.test(raw) && /krakenfutures:/.test(raw) && /krakenspot:/.test(raw));
  check('venueFromAssetId exported', /export function venueFromAssetId/.test(raw));
  check('venueFromAssetId is PURE (no fetch/await/module state)',
    !/fetch\(|await |useState/.test(stripComments(raw)));

  // ── Behavioral vector: exercise the PURE resolver directly. ──
  let v = { ok: false, detail: 'import failed' };
  try {
    const m = await import(pathToFileURL(path.join(ROOT, VMETA)).href);
    const checks = [];
    checks.push(['SOL-SPOT-KRS → krakenspot', m.venueFromAssetId('SOL-SPOT-KRS') === 'krakenspot']);
    checks.push(['SOL-PERP-KRX-5000 → kraken', m.venueFromAssetId('SOL-PERP-KRX-5000') === 'kraken']);
    checks.push(['SOL-PERP-KRF → krakenfutures', m.venueFromAssetId('SOL-PERP-KRF') === 'krakenfutures']);
    checks.push(['SOL-PERP-INTX → coinbase', m.venueFromAssetId('SOL-PERP-INTX') === 'coinbase']);
    checks.push(['BCP-20DEC30-CDE → coinbase', m.venueFromAssetId('BCP-20DEC30-CDE') === 'coinbase']);
    checks.push(['unknown → null (loud-absent)', m.venueFromAssetId('WEIRD-THING') === null]);
    checks.push(['empty → null', m.venueFromAssetId('') === null]);
    checks.push(['VENUE_META has 4 keys', Object.keys(m.VENUE_META).length === 4]);
    const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
    v = { ok: bad.length === 0, detail: bad.join('; ') };
  } catch (e) { v = { ok: false, detail: e.message }; }
  check('BEHAVIORAL: venueFromAssetId resolves all four suffix families + null', v.ok, v.detail);
}

// ═══════════════════ 2. MarketScanner — shared map + Part B cleanup ═══════════════════
console.log('\n── 2. MarketScanner.js — shared map + deploy-panel cleanup ──');
{
  const ms = read(SCANNER);
  const msCode = stripComments(ms);
  check('imports the shared venue-meta module', /from '\.\.\/lib\/venue-meta\.js'/.test(ms));
  check('no duplicated literal VENUE_META map remains', !/const VENUE_META = \{/.test(msCode));
  check('asset list sub-grouped by venue (venueFromAssetId per row)',
    /venueFromAssetId\(asset\.id\)/.test(msCode) && /VENUE_META\[vk\]\?\.label/.test(msCode));
  check('lifted venue prop (controlled venue)', /venue: venueProp/.test(msCode) && /venueProp \?\? venueState/.test(msCode));
  check('lifted selection restore (exact-id match)', /selectedAssetId/.test(msCode) && /a\.id === selectedAssetId/.test(msCode));

  // B1 — ONE qty box.
  check('legacy __notional_qty__ input RETIRED (strip display-only)', !/__notional_qty__/.test(msCode));
  check('notional strip reads the deploy qty (display-only)',
    /const notionalQty = \(sp\.qty != null && sp\.qty !== ''\) \? sp\.qty : '10'/.test(msCode));

  // B2 — no wipe on deploy success; deployed readback.
  const subBody = msCode.slice(msCode.indexOf('const subscribeToStrategy'), msCode.indexOf('const filteredAssets'));
  check('no setStrategyParams({}) in the subscribe success path', !/setStrategyParams\(\{\}\)/.test(subBody));
  check('deployed-readback binding present (binds to persisted config)',
    /deployedParams/.test(subBody) && /deployed\?\.config\?\.parameters/.test(subBody));
  check('params cleared on venue switch (the ONLY clear now)',
    /setStrategyParams\(\{\}\)/.test(msCode.slice(msCode.indexOf('const fetchAssets'), msCode.indexOf('const fetchAssets') + 1200)));

  // B3 — venue-conditional product_type.
  check('product_type is venue-conditional (SPOT for krakenspot)',
    /product_type: venue === 'krakenspot' \? 'SPOT' : 'FUTURES'/.test(msCode));
  check('no bare product_type: \'FUTURES\' literal remains in the scanner',
    !/product_type: 'FUTURES'/.test(msCode));
}

// ═══════════════════ 3. pages/index.js — card truth + sticky matrix ═══════════════════
console.log('\n── 3. pages/index.js — strategy card + sticky matrix ──');
{
  const ix = read(INDEX);
  const ixCode = stripComments(ix);
  check('imports the shared venue-meta module', /from '\.\.\/lib\/venue-meta\.js'/.test(ix));
  check('imports spot-margin-facts (chips + labels)', /from '\.\.\/lib\/spot-margin-facts\.js'/.test(ix));
  check('card renders a venue badge (VENUE_META label)', /VENUE_META\[vk\]\.label/.test(ixCode));
  const hStart = ixCode.indexOf('<span>Active Matrix</span>');
  const header = ixCode.slice(hStart, ixCode.indexOf('</h3>', hStart));
  check('card header renders the FULL asset id (not the base symbol)',
    /\{activeAsset\}/.test(header) && !/normalizeAssetSymbol\(activeAsset\)/.test(header));
  check('granular strip present (venue + asset + qty rows)', /GRANULAR STRIP/.test(ix) && /Asset<\/span>/.test(ix));
  check('Borrowing chips wired to subscribe-strategy', /deployCardLeverage/.test(ixCode) && /borrowingChipClass/.test(ixCode));
  check('chip rejects render as a toast (never silent)', /cardToast/.test(ixCode) && /setCardToast\(\{ kind: 'error'/.test(ixCode));

  // B3 — sticky matrix.
  const selHandler = ixCode.slice(ixCode.indexOf('onSelectAsset={(assetId) => {'), ixCode.indexOf('onSelectAsset={(assetId) => {') + 400);
  check('setShowScanner(false) GONE from the select handler (sticky matrix)',
    !/setShowScanner\(false\)/.test(selHandler));
  check('select handler records the lifted selection', /setScannerAssetId\(assetId\)/.test(selHandler));
  check('lifted venue + selection passed to the scanner',
    /venue=\{scannerVenue\}/.test(ixCode) && /selectedAssetId=\{scannerAssetId\}/.test(ixCode));
}

// ═══════════════════ 4. Prior gates still green (subprocess) ═══════════════════
console.log('\n── 4. am69-check (covers am68 + am64) subprocess ──');
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'am69-check.mjs')], { encoding: 'utf8' });
  check('am69-check green (transitively am68 + am64)', r.status === 0,
    (r.stdout || '').trim().split('\n').slice(-1)[0] || r.stderr);
}

// ─────────────────────────────────── report ────────────────────────────────
console.log(`\nAM70 check: ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error(`AM70 check: ${fail} FAILURE(S): ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
