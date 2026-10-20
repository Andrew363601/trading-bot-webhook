// scripts/am69-check.mjs
// 🟢 AM69 GATE — SPOT × MARGIN UX: the form is generated from the venue's facts.
//
// Verifies: chips derive from leverage_buy ∩ leverage_sell (never hardcoded), the
// EUR/TX line replaces chips when margin === false, the lane is side-aware and reuses
// the shared min-order strings, deploy/subscribe clamp from the provider facts (never
// the body), the risk validator is leverage-aware + LOUD, and the shared module
// behaves (BEHAVIORAL VECTOR via dynamic import).
//
// Read-only; never mutates the repo. Run: node scripts/am69-check.mjs

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

const FACTS = 'lib/spot-margin-facts.js';
const STUDIO = 'pages/studio.js';
const SCANNER = 'components/MarketScanner.js';
const DEP = 'pages/api/deploy-strategy.js';
const SUB = 'pages/api/subscribe-strategy.js';
const EXEC = 'lib/execute-trade-mcp.js';
const RISK = 'lib/risk-validator.js';
const SPOT = 'lib/providers/kraken-spot.js';

console.log('AM69 spot × margin UX check\n');

// ═══════════════════ 1. Shared module + BEHAVIORAL VECTOR ═══════════════════
console.log('── 1. lib/spot-margin-facts.js (single source of truth) ──');
check('module exists', exists(FACTS));
if (exists(FACTS)) {
  const raw = read(FACTS);
  check('deriveBorrowingLevels uses BOTH leverage arrays (intersection)',
    /deriveBorrowingLevels/.test(raw) && /leverage_buy/.test(raw) && /leverage_sell/.test(raw) && /sellSet\.has/.test(raw));
  check('isMarginEligible treats margin === false as ineligible', /margin !== false/.test(raw));
  check('maxLeverageForSide selects by side', /maxLeverageForSide/.test(raw) && /leverage_sell : facts\.leverage_buy/.test(raw));
  check('EUR/TX string exported verbatim', /Margin isn't available for EUR pairs on your account \(Texas restriction\) — cash orders only\./.test(raw));
  check('exported min-order string builder', /spotMinOrderError/.test(raw) && /Kraken Spot minimum order for/.test(raw));
  check('exported interest disclosure', /Interest accrues on borrowed funds\./.test(raw));

  // ── Behavioral vector: exercise the PURE functions directly. ──
  let v = { ok: false, detail: 'import failed' };
  try {
    const m = await import(pathToFileURL(path.join(ROOT, FACTS)).href);
    const facts = { base: 'SOL', quote: 'USD', margin: true, leverage_buy: [2, 3, 5], leverage_sell: [2, 3], ordermin: 0.5 };
    const eur = { base: 'BTC', quote: 'EUR', margin: false, leverage_buy: [2, 5], leverage_sell: [2, 5] };
    const checks = [];
    checks.push(['intersection of buy∩sell = [2,3]', JSON.stringify(m.deriveBorrowingLevels(facts)) === '[2,3]']);
    checks.push(['EUR pair → no levels', m.deriveBorrowingLevels(eur).length === 0]);
    checks.push(['isMarginEligible(EUR) === false', m.isMarginEligible(eur) === false]);
    checks.push(['side max sell = 3 (not buy 5)', m.maxLeverageForSide(facts, 'SELL') === 3]);
    checks.push(['side max buy = 5', m.maxLeverageForSide(facts, 'BUY') === 5]);
    checks.push(['EUR margin request rejected verbatim', m.validateKrakenSpotOrder({ facts: eur, leverage: 5, qty: 1 }).error === m.SPOT_MARGIN_EUR_ERROR]);
    checks.push(['intersection deploy checks lev>3 rejected', m.validateKrakenSpotOrder({ facts, leverage: 5, qty: 1 }).ok === false]);
    checks.push(['lev 3 accepted', m.validateKrakenSpotOrder({ facts, leverage: 3, qty: 1 }).ok === true]);
    checks.push(['side-aware sell lev 5 rejected at lane', m.validateKrakenSpotOrder({ facts, leverage: 5, qty: 1, side: 'sell' }).ok === false]);
    checks.push(['sub-ordermin qty rejected', m.validateKrakenSpotOrder({ facts, leverage: 1, qty: 0.2 }).ok === false]);
    checks.push(['cash (lev 1) accepted', m.validateKrakenSpotOrder({ facts, leverage: 1, qty: 1 }).ok === true]);
    checks.push(['long preview = cash/borrowed split', /your cash .*borrowed .*\(5×\)/.test(m.cashBorrowedPreview({ notional: 500, leverage: 5, side: 'long', base: 'SOL' }))]);
    checks.push(['short preview = borrowed base + buy-back', /borrowed .* of SOL \(5×\) · buy-back closes it/.test(m.cashBorrowedPreview({ notional: 500, leverage: 5, side: 'short', base: 'SOL' }))]);
    checks.push(['qty clamp lifts to ordermin', m.clampSpotQtyToOrdermin('0.2', facts).value === '0.5']);
    checks.push(['price snap to pair_decimals', m.snapSpotPriceToDecimals('123.456789', 2) === 123.46]);
    const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
    v = { ok: bad.length === 0, detail: bad.join('; ') };
  } catch (e) { v = { ok: false, detail: e.message }; }
  check('BEHAVIORAL: module functions behave (intersection/side/EUR/validate/preview/clamp)', v.ok, v.detail);
}

// ═══════════════════ 2. Studio — chips replace the free-number input ═══════════════════
console.log('\n── 2. studio.js — Borrowing chips ──');
{
  const st = read(STUDIO);
  const stCode = stripComments(st);
  check("no free-number krakenspot leverage input (the 'Margin (spot max' label is gone)",
    !/Margin \(spot max/.test(st));
  check('chips derive from the facts (deriveBorrowingLevels used)',
    /deriveBorrowingLevels\(assetFacts\[backtestProduct\]\)/.test(stCode));
  check("Cash chip maps to leverage '1'", /c === 'none' \? '1' : String\(c\)/.test(stCode));
  check('EUR/TX line renders instead of chips when !isMarginEligible',
    /!isMarginEligible\(facts\)/.test(stCode) && /SPOT_MARGIN_EUR_ERROR/.test(stCode));
  check('BORROWING_LABEL + CASH_CHIP_LABEL used', /BORROWING_LABEL/.test(stCode) && /CASH_CHIP_LABEL/.test(stCode));
  check('cash/borrowed preview + interest line present',
    /cashBorrowedPreview\(/.test(stCode) && /INTEREST_DISCLOSURE/.test(stCode));
  check('qty clamp to ordermin on blur', /clampSpotQtyToOrdermin\(simQty/.test(stCode));
  check('min-ordermin hint under the field', /spotQtyMinHint\(/.test(stCode));
  check('venue-aware backtest default (no bare || 10)',
    /assetExchange === 'krakenspot' \? 1 : 10/.test(stCode) && !/parseInt\(simLeverage, 10\) \|\| 10,/.test(stCode));
}

// ═══════════════════ 3. Scanner — full parity + card branch ═══════════════════
console.log('\n── 3. MarketScanner.js — full parity ──');
{
  const ms = read(SCANNER);
  const msCode = stripComments(ms);
  check('imports the shared module', /from '\.\.\/lib\/spot-margin-facts\.js'/.test(ms));
  check('krakenspot deploy qty control present', /Quantity \(\{selectedAsset\.base/.test(msCode));
  check('krakenspot Borrowing chips in the deploy panel', /deriveBorrowingLevels\(selectedAsset\)/.test(msCode));
  check('strategy qty/leverage param inputs filtered out (one control per field)',
    /filter\(\(\[key\]\) => !\(venue === 'krakenspot' && \(key === 'qty' \|\| key === 'leverage'\)\)\)/.test(msCode));
  check('Instrument Card Margin cell has a krakenspot branch',
    /venue === 'krakenspot'/.test(msCode) && /maxBorrowingLevel\(selectedAsset\)/.test(msCode));
  check('Instrument Card order-floors cell (min/notional/dec)', /Order floors/.test(msCode) && /ordermin/.test(msCode) && /costmin/.test(msCode));
  check("no bare `?? '—'` fact-default remains", !/contract_size \?\? '—'/.test(ms));
  check('notional strip carries the cash/borrowed split', /cashBorrowedPreview\(/.test(msCode));
}

// ═══════════════════ 4. Lane — side-aware + shared strings ═══════════════════
console.log('\n── 4. execute-trade-mcp.js — side-aware lane ──');
{
  const ex = read(EXEC);
  const exCode = stripComments(ex);
  check('imports maxLeverageForSide + min-order builders',
    /maxLeverageForSide/.test(exCode) && /spotMinOrderError/.test(exCode) && /spotMinCostError/.test(exCode));
  check('side-aware leverage guard (maxLeverageForSide(.., side))', /maxLeverageForSide\(krakenSpotProduct, side\)/.test(exCode));
  check('min-order veto uses the shared builder (no inline literal)',
    /reason: spotMinOrderError\(/.test(exCode) && !/Kraken Spot minimum order for \$\{rawSymbol\} is \$\{krakenSpotProduct/.test(exCode));
  check('min-cost veto uses the shared builder', /reason: spotMinCostError\(/.test(exCode));
  check('short entry maps sell + exits buy-back (ksClosingSide) intact',
    /ksClosingSide = side === 'BUY' \? 'sell' : 'buy'/.test(exCode));
  check('reduce_only margin gating intact', /ksReduceOnly = krakenSpotProduct\.margin !== false && leverage > 1/.test(exCode));
}

// ═══════════════════ 5. Server mirrors — facts from provider, shared strings ═══════════════════
console.log('\n── 5. deploy/subscribe — venue clamps ──');
for (const [label, file] of [['deploy', DEP], ['subscribe', SUB]]) {
  const src = read(file);
  const code = stripComments(src);
  check(`${label}: imports resolveKrakenSpotProduct`, /resolveKrakenSpotProduct/.test(code));
  check(`${label}: facts resolve from the PROVIDER (not the request body)`,
    /await resolveKrakenSpotProduct\(asset\)/.test(code));
  check(`${label}: validateKrakenSpotOrder used`, /validateKrakenSpotOrder\(/.test(code));
  check(`${label}: EUR/TX + leverage + ordermin enforced via the shared verdict`,
    /if \(!verdict\.ok\) return res\.status\(400\)/.test(code));
  check(`${label}: unresolved facts are LOUD (console.error), never silent`,
    /facts unresolved at/.test(src));
}
{
  const sub = read(SUB);
  const subCode = stripComments(sub);
  check('subscribe: update path merges ONLY qty+leverage (narrow whitelist)',
    /pickSpotUiParameters\(parameters\)/.test(subCode) && /existingStrategy\.parameters \|\| \{\}/.test(subCode));
  check('subscribe: whitelist touches exactly [qty, leverage]',
    /\['qty', 'leverage'\]/.test(subCode));
}

// ═══════════════════ 6. risk-validator — leverage-aware + LOUD ═══════════════════
console.log('\n── 6. risk-validator.js ──');
{
  const r = read(RISK);
  const rCode = stripComments(r);
  check('venue flags hoisted (isKrfLive + isKrSpotLive at function scope)',
    /const isKrfLive =/.test(rCode) && /const isKrSpotLive =/.test(rCode));
  check('spot-margin leverage multiplier present', /spotEffLeverage/.test(rCode) && /equityProxy \* spotEffLeverage/.test(rCode));
  check('LOUD fallback covers krakenspot too (isKrSpotLive in the warn gate)',
    /\(isKrfLive \|\| isKrSpotLive\) && realBalance\.error/.test(rCode));
  check('no duplicate flag re-declaration inside the LIVE block',
    (rCode.match(/const isKrfLive =/g) || []).length === 1);
}

// ═══════════════════ 7. No hardcoded margin anywhere ═══════════════════
console.log('\n── 7. doctrine — no hardcoded margin:true ──');
{
  const aa = exists('pages/api/available-assets.js') ? read('pages/api/available-assets.js') : '';
  check('no `margin: true` hardcode in available-assets.js', !/margin:\s*true/.test(stripComments(aa)));
  check('catalog carries leverage_buy + leverage_sell', /leverage_buy/.test(read(SPOT)) && /leverage_sell/.test(read(SPOT)));
}

// ═══════════════════ 8. Prior gates still green (subprocess) ═══════════════════
console.log('\n── 8. am68-check + am64-check (subprocess) ──');
{
  const { spawnSync } = await import('node:child_process');
  for (const gate of ['am68-check.mjs', 'am64-check.mjs']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', gate)], { encoding: 'utf8' });
    check(`${gate} green`, r.status === 0, (r.stdout || '').trim().split('\n').slice(-1)[0] || r.stderr);
  }
}

// ─────────────────────────────────── report ────────────────────────────────
console.log(`\nAM69 check: ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error(`AM69 check: ${fail} FAILURE(S): ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
