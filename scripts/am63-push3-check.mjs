// scripts/am63-push3-check.mjs
// 🟢 PUSH AM63 (Push 3) GATE — one venue selector, Kraken catalog, Kraken creds.
//
// Enforces the Push 3 contract. Execution stays Coinbase-only; every non-Coinbase
// path FAILS LOUD until Push 4. Everything here is read-only; exit 1 on violation.
//
//   1  available-assets.js: ?exchange= venue branch; Kraken maps via the Bitnomial
//      PUBLIC specs URL (cached); unknown venue → 400; the Coinbase path (top-rank
//      map) is untouched.
//   2  create-webhook-strategy.js no longer writes 'COINBASE'.
//   3  execute-trade-mcp.js resolvedExchange is lowercased.
//   4  deploy-strategy.js stamps a lowercased exchange + venue allowlist.
//   5  settings.js has the KRAKEN option + both placeholder variants + the vault
//      query is NOT a bare .single() (two-venue tenants would otherwise break prefill).
//   6  studio.js has the venue selector + ?exchange= fetch key + stale-race guard.
//   7  subscribe-strategy.js writes lowercase; MarketScanner.js WRITE is lowercase
//      while its VAULT READ stays 'COINBASE' (secrets-manager normalizes toUpperCase).
//   8  chat.js runBacktest config select COVERS exchange (the Push 2 blind spot).
//   9  lib/exchange-router.js still exports exactly the 2 known symbols (no drift).
//  10  migration 061 is present with the shape-convergence statements.
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push3-check.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
// Commit A ships this gate REPORT-ONLY (it inspects Commit B's Studio/deploy/settings
// wiring, which does not exist yet). Commit B flips this to false and the gate enforces.
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => { try { readFileSync(path.join(ROOT, rel)); return true; } catch { return false; } };

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ── 1. available-assets.js — venue branch + Kraken catalog ───────────────────
const AA = 'pages/api/available-assets.js';
if (!exists(AA)) {
  check('available-assets.js exists', false, AA + ' not found');
} else {
  const src = read(AA);
  check('available-assets reads ?exchange= (defaults coinbase)',
    /req\.query\.exchange\s*\|\|\s*'coinbase'/.test(src));
  check('available-assets has the kraken branch → handleKraken',
    /exchange\s*===\s*'kraken'/.test(src) && /handleKraken\s*\(/.test(src));
  check('available-assets refuses unknown venue LOUD (400 [AM63])',
    /400[\s\S]{0,80}\[AM63\] unsupported exchange/.test(src));
  check('Kraken maps via the Bitnomial PUBLIC specs URL',
    /bitnomial\.com\/exchange\/api\/v1\/prod\/product\/specs\/\?active=true/.test(src));
  check('Kraken fetch is cached (next: { revalidate: 3600 })',
    /revalidate:\s*3600/.test(src));
  check("Kraken filters type === 'perpetual' (exact) + active status",
    /p\.type\s*===\s*'perpetual'/.test(src) && /product_status\s*===\s*'active'/.test(src));
  check('Kraken id = ${base}-PERP-KRX-${contract_size}',
    /`\$\{[^}]*\}-PERP-KRX-\$\{[^}]*\}`/.test(src) || /-PERP-KRX-/.test(src));
  check('Kraken base comes from contract_size_unit (not base_symbol)',
    /base\s*=\s*p\.contract_size_unit/.test(src));
  check('Kraken carries native_symbol + product_id + exchange:kraken',
    /native_symbol:\s*p\.symbol/.test(src) && /product_id:\s*p\.product_id/.test(src) &&
    /exchange:\s*'kraken'/.test(src));
  check('Coinbase path untouched (TOP_RANK block still present)',
    /TOP_RANK/.test(src) && /\.slice\(0,\s*100\)/.test(src));
}

// ── 2. create-webhook-strategy.js — no 'COINBASE' literal ────────────────────
const CW = 'pages/api/create-webhook-strategy.js';
if (!exists(CW)) {
  check('create-webhook-strategy.js exists', false, CW + ' not found');
} else {
  const src = read(CW);
  check("create-webhook-strategy no longer contains 'COINBASE'", !/'COINBASE'/.test(src));
  check("create-webhook-strategy writes lowercase 'coinbase'", /exchange:\s*'coinbase'/.test(src));
}

// ── 3. execute-trade-mcp.js — resolvedExchange lowercased ───────────────────
const EXEC = 'lib/execute-trade-mcp.js';
if (!exists(EXEC)) {
  check('execute-trade-mcp.js exists', false, EXEC + ' not found');
} else {
  const src = read(EXEC);
  check('execute-trade-mcp resolvedExchange carries .toLowerCase()',
    /resolvedExchange\s*=\s*\(stratCfg\?\.exchange\s*\|\|\s*'coinbase'\)\.toLowerCase\(\)/.test(src) ||
    /resolvedExchange\s*=[\s\S]{0,60}\.toLowerCase\(\)/.test(src));
}

// ── 4. deploy-strategy.js — lowercased stamp + venue allowlist ──────────────
const DEP = 'pages/api/deploy-strategy.js';
if (!exists(DEP)) {
  check('deploy-strategy.js exists', false, DEP + ' not found');
} else {
  const src = read(DEP);
  check('deploy-strategy lowercases the inbound exchange',
    /\(body\.exchange\s*\|\|\s*'coinbase'\)\.toLowerCase\(\)/.test(src) ||
    /exchange[\s\S]{0,60}\.toLowerCase\(\)/.test(src));
  check("deploy-strategy stamps exchange into the upsert payload",
    /exchange\s*[:,]/.test(src) && /payload/.test(src));
  // 🟢 AM63 (Push 5) — the allowlist widened to admit 'krakenfutures' (real Kraken
  // Futures apiv3). The assertion now requires BOTH 'kraken' AND 'krakenfutures' so
  // the push3 contract (kraken admitted) is preserved while push5 extends it.
  check('deploy-strategy venue allowlist includes coinbase + kraken + krakenfutures',
    /\[\s*'coinbase'\s*,\s*'kraken'\s*,\s*'krakenfutures'\s*\]/.test(src));
}

// ── 5. settings.js — KRAKEN option, placeholders, vault query fix ───────────
const SET = 'pages/settings.js';
if (!exists(SET)) {
  check('settings.js exists', false, SET + ' not found');
} else {
  const src = read(SET);
  check('settings has the KRAKEN provider option (value="KRAKEN")',
    /<option\s+value="KRAKEN"/.test(src));
  check('settings adapts labels/placeholders per venue (Connection ID / Auth Token)',
    /Connection ID/.test(src) && /Auth Token/.test(src));
  check('settings keeps the Coinbase PEM placeholder',
    /-----BEGIN/.test(src));
  check('settings vault query is NOT a bare .single() (two-venue safe)',
    !/from\('api_keys_vault'\)[\s\S]{0,180}\.single\(\)/.test(src) &&
    /from\('api_keys_vault'\)/.test(src));
}

// ── 6. studio.js — venue selector + ?exchange= fetch key + race guard ───────
const STU = 'pages/studio.js';
if (!exists(STU)) {
  check('studio.js exists', false, STU + ' not found');
} else {
  const src = read(STU);
  check("studio has assetExchange state (default 'coinbase')",
    /setAssetExchange\s*\]\s*=\s*useState\(\s*'coinbase'\s*\)/.test(src));
  check('studio has the Venue selector',
    /Venue/.test(src) && /setAssetExchange\(/.test(src));
  check('studio fetches /api/available-assets?exchange=',
    /\/api\/available-assets\?exchange=\$\{/.test(src));
  check('studio guards against a stale venue race (fetchedVenueRef)',
    /fetchedVenueRef/.test(src));
  check('studio passes exchange in the backtest + deploy bodies',
    (src.match(/exchange:\s*assetExchange/g) || []).length >= 2);
}

// ── 7. writer convergence — subscribe-strategy + MarketScanner ──────────────
const SUB = 'pages/api/subscribe-strategy.js';
if (!exists(SUB)) {
  check('subscribe-strategy.js exists', false, SUB + ' not found');
} else {
  const src = read(SUB);
  check("subscribe-strategy default is lowercase 'coinbase'", /=\s*'coinbase'/.test(src));
  check('subscribe-strategy lowercases the incoming exchange',
    /\.toLowerCase\(\)/.test(src) && /normalizedExchange/.test(src));
  // NOTE: the vault READ still uses 'COINBASE' (api_keys_vault keeps its own
  // uppercase convention — deliberate asymmetry). The convergence target is the
  // strategy_config WRITE, so assert the insert payload uses the normalized value.
  check('subscribe-strategy writes normalizedExchange into strategy_config',
    /exchange:\s*normalizedExchange/.test(src));
}
const MS = 'components/MarketScanner.js';
if (!exists(MS)) {
  check('MarketScanner.js exists', false, MS + ' not found');
} else {
  const src = read(MS);
  // The VAULT keeps its OWN uppercase convention — secrets-manager.js normalizes with
  // exchange.toUpperCase() on BOTH write and read, so the read MUST use 'COINBASE'.
  check("MarketScanner reads the VAULT with 'COINBASE' (uppercase by design)",
    /\.eq\('exchange',\s*'COINBASE'\)/.test(src));
  // The strategy_config WRITE path is lowercase; the vault read is the ONLY place a
  // 'COINBASE' literal may remain.
  const coinbaseLiterals = (src.match(/'COINBASE'/g) || []).length;
  // 🟢 AM63 (Push 5) — the write is now `exchange: venue` (the venue state holds the
  // lowercase routing literal from the venue select). The push3 intent — a lowercase
  // canonical write — is preserved; accept either the literal or the venue state.
  check("MarketScanner writes a lowercase canonical exchange to strategy_config",
    /exchange:\s*'coinbase'/.test(src) || /exchange:\s*venue\b/.test(src));
  check("MarketScanner's only 'COINBASE' literal is the VAULT read",
    coinbaseLiterals === 1 && /\.eq\('exchange',\s*'COINBASE'\)/.test(src),
    `found ${coinbaseLiterals} 'COINBASE' literal(s), want exactly 1 (the vault read)`);
}

// ── 8. chat.js — runBacktest config select COVERS exchange ──────────────────
const CHAT = 'pages/api/chat.js';
if (!exists(CHAT)) {
  check('chat.js exists', false, CHAT + ' not found');
} else {
  const src = read(CHAT);
  // Anchor on the exchange-resolution query (the select near the runBacktest tool).
  const selMatch = src.match(/\.select\('([^']*)'\)[\s\S]{0,200}?\.eq\('strategy',\s*cleanName\)/);
  check("chat runBacktest select covers 'exchange'",
    !!selMatch && (/\bexchange\b/.test(selMatch[1]) || selMatch[1].trim() === '*'),
    selMatch ? `select = '${selMatch[1]}'` : 'exchange-resolution select not found');
  check('chat passes exchange into runBacktestForTenant',
    /exchange[\s\S]{0,500}?runBacktestForTenant|runBacktestForTenant[\s\S]{0,500}?exchange/.test(src));
}

// ── 9. exchange-router.js — exactly the 2 known exports (no drift) ──────────
const ROUTER = 'lib/exchange-router.js';
if (!exists(ROUTER)) {
  check('exchange-router.js exists', false, ROUTER + ' not found');
} else {
  try {
    const mod = await import('../lib/exchange-router.js');
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    check('exchange-router exports exactly resolveExchange + assertExchangeSupported',
      fns.length === 2 && fns[0] === 'assertExchangeSupported' && fns[1] === 'resolveExchange',
      `found [${fns.join(', ')}]`);
    check('exchange-router does NOT export requireAdapterFor (no dead API)',
      typeof mod.requireAdapterFor === 'undefined');
  } catch (e) {
    check('exchange-router.js imports cleanly', false, e.message);
  }
}

// ── 10. migration 061 — shape convergence ───────────────────────────────────
const MIG = 'supabase/migrations/061-exchange-shape-converge.sql';
if (!exists(MIG)) {
  check('061 migration exists', false, MIG + ' not found');
} else {
  const sql = read(MIG).replace(/\s+/g, ' ');
  check('061 normalizes exchange to canonical coinbase (idempotent)',
    /where lower\(exchange\) <> 'coinbase'/i.test(sql) ||
    /set exchange = lower\(exchange\)/i.test(sql));
  check("061 pins default 'coinbase'",
    /alter column exchange set default 'coinbase'/i.test(sql));
  check('061 pins NOT NULL',
    /alter column exchange set not null/i.test(sql));
}

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 3 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
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
