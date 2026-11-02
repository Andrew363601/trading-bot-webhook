// scripts/am72-check.mjs
// 🟢 AM72 GATE — single execution_mode truth + canonical parameters schema +
// contract-spec panel + close-router hardening + webhook silent-PAPER guard +
// qty governance.
//
//   1  lib/strategy-params.js: canonical schema + sanitize/pick/hasLegacy
//      (BEHAVIORAL vectors).
//   2  lib/venue-fees.js: per-side taker constants (BEHAVIORAL vectors).
//   3  subscribe-strategy.js: reads execution_mode from the TOP-LEVEL body /
//      column — NEVER parameters.execution_mode; sanitizes the blob.
//   4  write paths strip the blob: deploy-strategy, strategy-config-update,
//      create-webhook-strategy, chat.js manageStrategy, index.js edit-modal save.
//   5  webhook.js + webhook/[token].js: LOUD config_not_found (never silent PAPER).
//   6  execute-trade-mcp.js: explicit data.action routing + close_failed_no_open_trade
//      + venue-derived market_type + qty governance.
//   7  migration 064: idempotent scrub, strategy_config ONLY.
//   8  kraken-spot.js: contractSize:1 in the catalog; available-assets reads it.
//   9  genetic-optimizer: market_type dropped, execution_mode KEPT.
//
// Read-only; never mutates the repo. Run: node scripts/am72-check.mjs

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

console.log('AM72 single-mode-truth + canonical params + close-router + webhook guard check\n');

// ═══════════════════ 1. lib/strategy-params.js ═══════════════════
console.log('── 1. lib/strategy-params.js — canonical schema ──');
const SP = 'lib/strategy-params.js';
check('strategy-params.js exists', exists(SP));
if (exists(SP)) {
  let m = null;
  try { m = await import(pathToFileURL(path.join(ROOT, SP)).href); }
  catch (e) { check('strategy-params imports cleanly', false, e.message); }

  if (m) {
    check('CANONICAL_PARAM_KEYS has the 9 canonical keys',
      Array.isArray(m.CANONICAL_PARAM_KEYS) && m.CANONICAL_PARAM_KEYS.length === 9 &&
      ['qty', 'leverage', 'macro_tf', 'trigger_tf', 'tp_percent', 'sl_percent',
       'tripwire_percent', 'trail_step_percent', 'veto_cooldown_minutes']
        .every((k) => m.CANONICAL_PARAM_KEYS.includes(k)));
    check('LEGACY_PARAM_KEYS has the 5 legacy keys',
      Array.isArray(m.LEGACY_PARAM_KEYS) && m.LEGACY_PARAM_KEYS.length === 5 &&
      ['quantity', 'stop_loss_pct', 'take_profit_pct', 'market_type', 'execution_mode']
        .every((k) => m.LEGACY_PARAM_KEYS.includes(k)));

    // BEHAVIORAL: sanitize strips legacy, keeps canonical + brain-owned.
    const dirty = {
      qty: 2, leverage: 5, macro_tf: 'ONE_HOUR', trigger_tf: 'FIVE_MINUTE',
      tp_percent: 0.05, sl_percent: 0.02, tripwire_percent: 0.0025,
      trail_step_percent: 0.001, veto_cooldown_minutes: 10,
      quantity: 99, stop_loss_pct: 0.9, take_profit_pct: 0.9,
      market_type: 'FUTURES', execution_mode: 'LIVE',
      regime_params: { TREND: { tp_percent: 0.03 } }, agent_adjusted: true,
    };
    const clean = m.sanitizeParameters(dirty);
    check('BEHAVIORAL: sanitize drops all 5 legacy keys',
      ['quantity', 'stop_loss_pct', 'take_profit_pct', 'market_type', 'execution_mode']
        .every((k) => !(k in clean)));
    check('BEHAVIORAL: sanitize keeps canonical keys',
      clean.qty === 2 && clean.leverage === 5 && clean.tp_percent === 0.05);
    check('BEHAVIORAL: sanitize keeps brain-owned keys (regime_params/agent_adjusted)',
      clean.regime_params && clean.regime_params.TREND && clean.agent_adjusted === true);
    check('BEHAVIORAL: sanitize does not mutate the input',
      dirty.execution_mode === 'LIVE' && dirty.market_type === 'FUTURES');
    check('BEHAVIORAL: sanitize(non-object) → {}',
      Object.keys(m.sanitizeParameters(null)).length === 0 &&
      Object.keys(m.sanitizeParameters('x')).length === 0);

    const picked = m.pickCanonical(dirty);
    check('BEHAVIORAL: pickCanonical keeps ONLY canonical keys',
      Object.keys(picked).length === 9 && !('regime_params' in picked) && !('execution_mode' in picked));

    check('BEHAVIORAL: hasLegacyParams true for dirty, false for clean',
      m.hasLegacyParams(dirty) === true && m.hasLegacyParams(clean) === false);
  }
}

// ═══════════════════ 2. lib/venue-fees.js ═══════════════════
console.log('\n── 2. lib/venue-fees.js — per-side taker constants ──');
const VF = 'lib/venue-fees.js';
check('venue-fees.js exists', exists(VF));
if (exists(VF)) {
  let m = null;
  try { m = await import(pathToFileURL(path.join(ROOT, VF)).href); }
  catch (e) { check('venue-fees imports cleanly', false, e.message); }
  if (m) {
    check('BEHAVIORAL: coinbase = 8 bps/side (NOT 16 — that is round trip)',
      m.takerFeeBpsPerSide('coinbase') === 8);
    check('BEHAVIORAL: krakenspot = 26 bps/side', m.takerFeeBpsPerSide('krakenspot') === 26);
    check('BEHAVIORAL: krakenfutures = 5 bps/side', m.takerFeeBpsPerSide('krakenfutures') === 5);
    check('BEHAVIORAL: unknown venue → null (honest-absent)', m.takerFeeBpsPerSide('bybit') === null);
    check('BEHAVIORAL: label carries the /side semantic',
      m.takerFeeLabel('krakenspot') === 'Taker: 26 bps/side');
    check('BEHAVIORAL: unknown venue label is honest-absent',
      m.takerFeeLabel('bybit') === 'Taker: —');
  }
}

// ═══════════════════ 3. subscribe-strategy column read ═══════════════════
console.log('\n── 3. subscribe-strategy.js — single mode truth ──');
const SUB = 'pages/api/subscribe-strategy.js';
check('subscribe-strategy.js exists', exists(SUB));
if (exists(SUB)) {
  const src = read(SUB);
  const code = stripComments(src);
  check('reads execution_mode from the TOP-LEVEL body (destructured)',
    /execution_mode\s*\}\s*=\s*req\.body/.test(code));
  check('executionMode derives from the top-level field, NOT parameters',
    /const executionMode = execution_mode \|\| 'PAPER'/.test(code));
  check('the OLD parameters?.execution_mode read is GONE',
    !/parameters\?\.execution_mode/.test(code));
  check('update path selects the execution_mode COLUMN',
    /select\('id, parameters, execution_mode'\)/.test(code));
  check('update path preserves the stored column when the caller omits the mode',
    /execution_mode: execution_mode \|\| existingStrategy\.execution_mode \|\| 'PAPER'/.test(code));
  check('insert path sanitizes the merged blob',
    /sanitizeParameters\(\{ \.\.\.defaultParameters/.test(code));
  check('update path sanitizes the merged blob',
    /sanitizeParameters\(\{ \.\.\.\(existingStrategy\.parameters/.test(code));
  check('default blob no longer carries market_type',
    !/market_type:\s*"FUTURES"/.test(code));
}

// ═══════════════════ 4. write paths strip the blob ═══════════════════
console.log('\n── 4. write paths — sanitize the parameters blob ──');
for (const [label, rel, pin] of [
  ['deploy-strategy', 'pages/api/deploy-strategy.js', /parameters: sanitizeParameters\(config\)/],
  ['strategy-config-update', 'pages/api/strategy-config-update.js', /sanitizeParameters\(\{ \.\.\.config\.parameters, \.\.\.parameters \}\)/],
  ['create-webhook-strategy', 'pages/api/create-webhook-strategy.js', /import \{ sanitizeParameters \}/],
  ['chat.js manageStrategy', 'pages/api/chat.js', /sanitizeParameters\(\{ \.\.\.existingParams, \.\.\.incomingParams \}\)/],
]) {
  check(`${label} exists`, exists(rel));
  if (exists(rel)) check(`${label} sanitizes the blob`, pin.test(read(rel)));
}
// create-webhook-strategy default blob must not carry market_type.
if (exists('pages/api/create-webhook-strategy.js')) {
  check('create-webhook-strategy default blob drops market_type',
    !/market_type:\s*'FUTURES'/.test(read('pages/api/create-webhook-strategy.js')));
}
// index.js edit modal: filters legacy keys + sanitizes on save.
if (exists('pages/index.js')) {
  const ix = read('pages/index.js');
  check('edit modal filters LEGACY_PARAM_KEYS from the editor',
    /if \(LEGACY_PARAM_KEYS\.includes\(key\)\) continue;/.test(ix));
  check('edit modal save sanitizes the blob',
    /const cleanParams = sanitizeParameters\(flatParams\)/.test(ix) &&
    /parameters: cleanParams,/.test(ix));
  check('edit modal imports sanitizeParameters + LEGACY_PARAM_KEYS',
    /import \{ sanitizeParameters, LEGACY_PARAM_KEYS \}/.test(ix));
  check('strategy card renders the contract-spec strip (Product/Tick/Min order/Fee)',
    /CONTRACT-SPEC STRIP/.test(ix) && /takerFeeLabel\(vk\)/.test(ix));
}
// MarketScanner: execution_mode moved OUT of the blob to top-level.
if (exists('components/MarketScanner.js')) {
  const ms = read('components/MarketScanner.js');
  check('MarketScanner sends execution_mode TOP-LEVEL (not in parameters)',
    /execution_mode: executionMode,/.test(ms) && !/execution_mode: executionMode \/\/ Inject/.test(ms));
  check('MarketScanner Instrument Card shows the taker fee',
    /takerFeeLabel\(venueFromAssetId\(selectedAsset\.id\)\)/.test(ms));
}
// index.js granular-strip caller: execution_mode top-level.
if (exists('pages/index.js')) {
  const ix = read('pages/index.js');
  check('index.js leverage caller sends execution_mode TOP-LEVEL',
    /execution_mode: strat\.execution_mode \|\| 'PAPER',/.test(ix));
}

// ═══════════════════ 5. webhook silent-PAPER guard ═══════════════════
console.log('\n── 5. webhook — LOUD config_not_found (never silent PAPER) ──');
for (const rel of ['pages/api/webhook.js', 'pages/api/webhook/[token].js']) {
  check(`${rel} exists`, exists(rel));
  if (!exists(rel)) continue;
  const src = read(rel);
  check(`${rel} returns status config_not_found`, /status: 'config_not_found'/.test(src));
  check(`${rel} has a Discord alert helper`, /async function sendDiscordAlert/.test(src));
  check(`${rel} has an agent-log helper`, /async function logAgentActivity/.test(src));
  check(`${rel} logs CONFIG_NOT_FOUND`, /'CONFIG_NOT_FOUND'/.test(src));
}
if (exists('pages/api/webhook.js')) {
  const w = read('pages/api/webhook.js');
  check('webhook.js guards a STRATEGY trade (strategy_id != MANUAL) on a lookup miss',
    /const isStrategyTrade = !!data\.strategy_id && data\.strategy_id !== 'MANUAL'/.test(w) &&
    /if \(isStrategyTrade && !config\)/.test(w));
}
if (exists('pages/api/webhook/[token].js')) {
  const w = read('pages/api/webhook/[token].js');
  check('webhook/[token].js refuses a null execution_mode (no PAPER default)',
    /if \(!execution_mode\)/.test(w) && /execution_mode,\r?\n/.test(w));
}

// ═══════════════════ 6. execute-trade-mcp close-router + market_type + qty ═══════════════════
console.log('\n── 6. execute-trade-mcp.js — close-router + market_type + qty ──');
const EX = 'lib/execute-trade-mcp.js';
check('execute-trade-mcp.js exists', exists(EX));
if (exists(EX)) {
  const src = read(EX);
  const code = stripComments(src);
  check('reads an explicit data.action', /const action = data\.action \|\| null;/.test(code));
  check('CLOSE with no open trade → close_failed_no_open_trade',
    /status: 'close_failed_no_open_trade'/.test(code));
  check('CLOSE-no-trade path alerts Discord LOUD',
    /\[AM72 close_failed_no_open_trade\]/.test(code) && /sendDiscordAlert\(tenantId, \{/.test(code));
  check('ADJUST_TP_SL with no open trade → adjust_failed_no_open_trade',
    /status: 'adjust_failed_no_open_trade'/.test(code));
  check('isClosing honours the explicit CLOSE action',
    /const isClosing = \(openTrade && openTrade\.side !== side\) \|\| isLiveDirectClose \|\| action === 'CLOSE';/.test(code));
  check('isBracketAdjustment honours the explicit ADJUST_TP_SL action',
    /const isBracketAdjustment = \(tradeReason && tradeReason\.includes\('ADJUST_TP_SL'\)\) \|\| action === 'ADJUST_TP_SL';/.test(code));
  check('market_type is DERIVED from the venue (krakenspot → SPOT)',
    /const marketType = resolvedExchange === 'krakenspot' \? 'SPOT' : \(data\.market_type \|\| 'FUTURES'\);/.test(code));
  check('the early marketType stamp (before resolvedExchange) is GONE',
    !/if \(!leverage \|\| leverage < 1\) leverage = 1;\s*\n\s*const marketType = data\.market_type/.test(code));
  check('qty governance stamps qty_source:caller',
    /entryParamsContext\.qty_source = 'caller';/.test(code) && /\[AM72 QTY\]/.test(code));
}

// ═══════════════════ 7. migration 064 ═══════════════════
console.log('\n── 7. migration 064 — idempotent scrub ──');
const MIG = 'supabase/migrations/064-scrub-strategy-params.sql';
check('migration 064 exists', exists(MIG));
if (exists(MIG)) {
  const sql = read(MIG);
  check('scrubs all 5 legacy keys via jsonb minus',
    /- 'quantity'/.test(sql) && /- 'stop_loss_pct'/.test(sql) && /- 'take_profit_pct'/.test(sql) &&
    /- 'market_type'/.test(sql) && /- 'execution_mode'/.test(sql));
  check('idempotent WHERE uses ?| array[...]',
    /where parameters \?\| array\['quantity', 'stop_loss_pct', 'take_profit_pct', 'market_type', 'execution_mode'\]/.test(sql));
  check('scope is strategy_config ONLY (no trade_logs update)',
    /update strategy_config/.test(sql) && !/update trade_logs/.test(sql));
  check('no uuid-ossp dependency (no create extension)',
    !/create\s+extension/i.test(sql));
}

// ═══════════════════ 8. kraken-spot contractSize ═══════════════════
console.log('\n── 8. kraken-spot.js — contractSize:1 catalog value ──');
const KS = 'lib/providers/kraken-spot.js';
check('kraken-spot.js exists', exists(KS));
if (exists(KS)) {
  check('catalog entry carries contractSize: 1',
    /contractSize: 1,/.test(read(KS)));
}
if (exists('pages/api/available-assets.js')) {
  const aa = read('pages/api/available-assets.js');
  check('available-assets reads inst.contractSize (not a hardcoded literal)',
    /contract_size: inst\.contractSize != null \? inst\.contractSize : 1,/.test(aa));
}

// ═══════════════════ 9. genetic-optimizer protected keys ═══════════════════
console.log('\n── 9. genetic-optimizer.js — protected keys ──');
const GO = 'pages/api/genetic-optimizer.js';
check('genetic-optimizer.js exists', exists(GO));
if (exists(GO)) {
  const src = read(GO);
  const block = src.slice(src.indexOf('PROTECTED_PARAM_KEYS'), src.indexOf('];', src.indexOf('PROTECTED_PARAM_KEYS')));
  check('execution_mode is KEPT in PROTECTED_PARAM_KEYS', /'execution_mode'/.test(block));
  check('market_type is DROPPED from PROTECTED_PARAM_KEYS', !/'market_type'/.test(block));
}

// ═══════════════════ summary ═══════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`AM72 check: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
