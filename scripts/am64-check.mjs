// scripts/am64-check.mjs
// 🟢 PUSH AM64 GATE — Instrument Truth: venue-native contract facts in the UI.
//
// Enforces the AM64 contract (spec: AM64_UI_INSTRUMENT_TRUTH.md, ratified preview:
// nexus-ui-preview.html). Everything here is read-only; exit 1 on violation.
//
//   1  Per-venue field-map pins: each enriched field name appears in the correct
//      handler (krakenfutures / kraken / coinbase) of available-assets.js, and the
//      provider (kraken-futures.js loadInstruments) carries the KRF source fields.
//   2  Honest-absence: no `?? 0` fabricated defaults on the new fields; the '—'
//      render path exists for absent facts.
//   3  Venue copy literals: the three VENUE_META entries exist; "Syncing with
//      Coinbase" appears ONLY inside the coinbase entry.
//   4  LIVE-gate matrix: CDE gate scoped to coinbase; KRF branch requires the
//      KRAKENFUTURES vault check; kraken → PAPER-only popup copy present (UI +
//      both server routes).
//   5  Notional formula pin: qty × contract_size × price appears in BOTH files;
//      NO server-side notional computation exists in available-assets.js.
//   6  Toast: zero `alert(` occurrences remain in MarketScanner.js.
//   7  Preview artifact committed: nexus-ui-preview.html exists at repo root.
//
// Run: node scripts/am64-check.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => { try { readFileSync(path.join(ROOT, rel)); return true; } catch { return false; } };
// Strip `//` line comments AND `{/* … */}` JSX comments (naive — good enough for
// literal scans). Prevents comment MENTIONS ("replaces native alert()") from
// false-failing the zero-occurrence pins. Handles CRLF (\r would otherwise block
// `.*$` from matching the comment tail).
const stripComments = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map(l => l.replace(/\/\/.*$/, ''))
  .join('\n');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ── 1. Per-venue field maps ─────────────────────────────────────────────────
const AA = 'pages/api/available-assets.js';
if (!exists(AA)) {
  check('available-assets.js exists', false, AA + ' not found');
} else {
  const src = read(AA);

  // krakenfutures handler fields
  check('KRF: initial_margin mapped', /initial_margin:\s*inst\.initialMargin/.test(src));
  check('KRF: maintenance_margin mapped', /maintenance_margin:\s*inst\.maintenanceMargin/.test(src));
  check('KRF: max_position_size mapped', /max_position_size:\s*inst\.maxPositionSize/.test(src));
  check('KRF: funding_interval_hours present (8h KRF standard)', /funding_interval_hours:\s*8/.test(src));
  check('KRF: max_relative_funding_rate mapped', /max_relative_funding_rate:\s*inst\.maxRelativeFundingRate/.test(src));
  check('KRF: category mapped', /category:\s*inst\.category/.test(src));

  // kraken (Bitnomial) handler fields — forwarded from the SAME specs record
  check('KRX: margin_unit mapped', /margin_unit:\s*p\.margin_unit/.test(src));
  check('KRX: settlement_method mapped', /settlement_method:\s*p\.settlement_method/.test(src));
  check('KRX: max_order_quantity mapped', /max_order_quantity:\s*p\.max_order_quantity/.test(src));
  check('KRX: min_block_size mapped', /min_block_size:\s*p\.min_block_size/.test(src));
  check('KRX: price_limit_percentage mapped', /price_limit_percentage:\s*p\.price_limit_percentage/.test(src));
  check('KRX: funding_interval_hours mapped', /funding_interval_hours:\s*p\.funding_interval_hours/.test(src));
  check('KRX: funding bounds mapped', /funding_rate_upper_bound:\s*p\.funding_rate_upper_bound/.test(src) &&
    /funding_rate_lower_bound:\s*p\.funding_rate_lower_bound/.test(src));
  check('KRX: daily open/settle times mapped', /daily_open_time:\s*p\.daily_open_time/.test(src) &&
    /daily_settle_time:\s*p\.daily_settle_time/.test(src));
  check('KRX: price_quotation_unit mapped', /price_quotation_unit:\s*p\.price_quotation_unit/.test(src));
  check('KRX: product_status mapped', /product_status:\s*p\.product_status/.test(src));

  // coinbase authed mapping — defensive probed fields
  check('CB: contract_size mapped (defensive)', /contract_size:\s*p\.contract_size/.test(src));
  check('CB: contract_root_unit mapped', /contract_root_unit:\s*p\.contract_root_unit/.test(src));
  check('CB: product_venue mapped', /product_venue:\s*p\.product_venue/.test(src));
  check('CB: base/quote increments mapped', /base_increment:\s*p\.base_increment/.test(src) &&
    /quote_increment:\s*p\.quote_increment/.test(src));
  check('CB: probe-first raw record log present', /AM64 PROBE/.test(src));

  // Provider source fields (loadInstruments entry)
  const PROVIDER = 'lib/providers/kraken-futures.js';
  if (exists(PROVIDER)) {
    const psrc = read(PROVIDER);
    check('Provider: marginLevels[0] initialMargin captured', /initialMargin:\s*Array\.isArray\(p\.marginLevels\)/.test(psrc));
    check('Provider: marginLevels[0] maintenanceMargin captured', /maintenanceMargin:\s*Array\.isArray\(p\.marginLevels\)/.test(psrc));
    check('Provider: fundingRateCoefficient captured', /fundingRateCoefficient:\s*p\.fundingRateCoefficient/.test(psrc));
    check('Provider: maxRelativeFundingRate captured', /maxRelativeFundingRate:\s*p\.maxRelativeFundingRate/.test(psrc));
    check('Provider: category captured', /category:\s*p\.category/.test(psrc));
  } else {
    check('provider exists', false, PROVIDER + ' not found');
  }
}

// ── 2. Honest-absence ───────────────────────────────────────────────────────
{
  const src = exists(AA) ? read(AA) : '';
  // No fabricated defaults on the new fields: `?? 0` must not appear anywhere in
  // the catalog (the ONLY numeric defaults allowed are the pre-existing price/vol 0s).
  check('Honest-absence: no `?? 0` fabricated defaults in available-assets.js', !/\?\?\s*0/.test(src));
  const MS = 'components/MarketScanner.js';
  if (exists(MS)) {
    const msrc = read(MS);
    // The '—' render path exists for absent facts (Instrument Card).
    check("UI: '—' render path exists for absent facts", /'—'/.test(msrc));
    // KRX mark-pending chip (honest, not $0.00).
    check('UI: KRX mark-pending chip present', /mark pending/.test(msrc));
  } else {
    check('MarketScanner.js exists', false, MS + ' not found');
  }
}

// ── 3. Venue copy literals (VENUE_META) ─────────────────────────────────────
const MS = 'components/MarketScanner.js';
if (!exists(MS)) {
  check('MarketScanner.js exists', false, MS + ' not found');
} else {
  const src = read(MS);
  check('VENUE_META map exists', /const\s+VENUE_META\s*=\s*\{/.test(src));
  check('VENUE_META: coinbase entry with accent #0B6BFF', /coinbase:\s*\{[\s\S]{0,200}?#0B6BFF/.test(src));
  check('VENUE_META: kraken entry with accent #FF8A3C', /kraken:\s*\{[\s\S]{0,200}?#FF8A3C/.test(src));
  check('VENUE_META: krakenfutures entry with accent #7C5CFF', /krakenfutures:\s*\{[\s\S]{0,200}?#7C5CFF/.test(src));
  // "Syncing with Coinbase" must appear ONLY inside the coinbase entry — i.e. the
  // hardcoded render-site copy is gone (the render site now reads VENUE_META[venue]).
  const syncIdx = src.indexOf('Syncing with Coinbase');
  const metaIdx = src.indexOf('const VENUE_META');
  const renderSyncIdx = src.indexOf("VENUE_META[venue]?.sync");
  check('"Syncing with Coinbase" only inside VENUE_META (render site venue-aware)',
    syncIdx >= 0 && metaIdx >= 0 && syncIdx > metaIdx && renderSyncIdx >= 0 &&
    syncIdx < src.indexOf('kraken:', metaIdx));
  check('Render site consumes VENUE_META sync copy', /VENUE_META\[venue\]\?\.sync/.test(src));
  check('Render site consumes VENUE_META matrixName', /VENUE_META\[venue\]\?\.matrixName/.test(src));
  check('Panel root carries --acc CSS custom property', /'--acc':\s*VENUE_META\[venue\]/.test(src));
}

// ── 4. LIVE-gate matrix ─────────────────────────────────────────────────────
{
  const src = read(MS);
  // CDE gate scoped to the coinbase branch (inside the venue === 'coinbase' path —
  // asserted via the kraken/krakenfutures branches preceding it).
  // 🟢 AM68 — the US-futures copy changed from the stale "Push 8" string to the truthful
  // Kraken-no-US-futures-API string + the US_FUTURES_NO_KRAKEN_API reason marker.
  check('UI gate: kraken → PAPER-only blocking popup', /venue === 'kraken'[\s\S]{0,400}Kraken has no US-futures API/.test(src));
  check('UI gate: krakenfutures branch exists', /venue === 'krakenfutures'/.test(src));
  check('UI gate: KRF keys check gates the KRF branch', /hasKrakenFuturesKeys === false/.test(src));
  check('UI gate: CDE check still present (coinbase branch)', /isCDEAsset\(selectedAsset\.id\)/.test(src));
  check('UI gate: KRF vault read uses UPPERCASE KRAKENFUTURES literal', /\.eq\('exchange',\s*'KRAKENFUTURES'\)/.test(src));
  // The COINBASE vault read stays EXACTLY once (push3 pin: the only 'COINBASE'
  // literal in MarketScanner is the vault read).
  const coinbaseLiterals = (src.match(/'COINBASE'/g) || []).length;
  check("MarketScanner's only 'COINBASE' literal is the vault read (push3 pin preserved)",
    coinbaseLiterals === 1 && /\.eq\('exchange',\s*'COINBASE'\)/.test(src),
    `found ${coinbaseLiterals} 'COINBASE' literal(s), want exactly 1`);
}

{
  const SUB = 'pages/api/subscribe-strategy.js';
  const src = read(SUB);
  // 🟢 AM68 — copy evolved to the truthful US-futures string + reason marker.
  check('Server(subscribe): kraken → PAPER-only 400', /normalizedExchange === 'kraken'[\s\S]{0,300}Kraken has no US-futures API/.test(src) && /US_FUTURES_NO_KRAKEN_API/.test(src));
  check('Server(subscribe): CDE block scoped to non-krakenfutures', /normalizedExchange !== 'krakenfutures' && !isCDEAsset/.test(src));
  check('Server(subscribe): vault venue derived (KRAKENFUTURES sibling)', /vaultVenue/.test(src) && /'KRAKENFUTURES'/.test(src));
  check('Server(subscribe): lowercase write pin intact (normalizedExchange)', /exchange:\s*normalizedExchange/.test(src));
}

{
  const DEP = 'pages/api/deploy-strategy.js';
  const src = read(DEP);
  // 🟢 AM68 — copy evolved to the truthful US-futures string + reason marker.
  check('Server(deploy): kraken → PAPER-only 400', /deployExchange === 'kraken'[\s\S]{0,300}Kraken has no US-futures API/.test(src) && /US_FUTURES_NO_KRAKEN_API/.test(src));
  check('Server(deploy): CDE block scoped to non-krakenfutures', /deployExchange !== 'krakenfutures' && !isCDEAsset/.test(src));
  check('Server(deploy): vault venue derived (KRAKENFUTURES sibling)', /vaultVenue/.test(src) && /'KRAKENFUTURES'/.test(src));
  check('Server(deploy): allowlist pin intact', /KNOWN_EXCHANGES\s*=\s*\[[^\]]*'krakenfutures'/.test(src));
}

// ── 5. Notional formula pin ─────────────────────────────────────────────────
{
  const ms = read(MS);
  const st = read('pages/studio.js');
  // The exact expression `q * (…) * px` inside computeNotional — both files carry
  // the IDENTICAL function body.
  const formula = /const notional = q \* \(Number\.isFinite\(cs\) && cs > 0 \? cs : 1\) \* px;/;
  check('Notional formula present in MarketScanner.js', formula.test(ms));
  check('Notional formula present in studio.js', formula.test(st));
  check('Notional uses Intl.NumberFormat USD (both files)',
    /Intl\.NumberFormat\('en-US',\s*\{[^}]*currency:\s*'USD'/.test(ms) &&
    /Intl\.NumberFormat\('en-US',\s*\{[^}]*currency:\s*'USD'/.test(st));
  // NO server-side notional computation in the catalog (price staleness × cache).
  // Comment mentions are stripped first — only CODE counts.
  const aa = stripComments(read(AA));
  check('No server-side notional in available-assets.js', !/notional/i.test(aa));
}

// ── 6. Toast ────────────────────────────────────────────────────────────────
{
  const src = stripComments(read(MS));
  check('Zero alert( occurrences remain in MarketScanner.js', !/alert\(/.test(src));
  check('Toast state + showToast helper present', /const \[toast, setToast\]/.test(src) && /showToast\(/.test(src));
}

// ── 7. Preview artifact ─────────────────────────────────────────────────────
check('nexus-ui-preview.html committed at repo root', exists('nexus-ui-preview.html'));

// ── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\nam64-check: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`am64-check: ${failed.length} FAILURE(S)`);
  process.exit(1);
}
