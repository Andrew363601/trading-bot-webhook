// scripts/am63-push2-check.mjs
// 🟢 PUSH AM63 (Push 2) GATE — exchange columns + router seam.
//
// Enforces the Push 2 contract (ZERO visible change; Coinbase still everywhere):
//   1  Migration 060 exists with a per-table `exchange` column (NOT NULL DEFAULT
//      'coinbase') on BOTH strategy_config and trade_logs, + the tenant index.
//   2  lib/exchange-router.js resolves ONLY 'coinbase'; unknown venues are
//      supported:false; assertExchangeSupported throws on them; requireAdapterFor
//      does NOT exist (no dead API for Push 4).
//   3  execute-trade-mcp.js stamps `resolvedExchange` in BOTH payloads, handles
//      `exchange` in BOTH safety nets, and the stratCfg select COVERS `exchange`
//      (the blind spot the gate exists to catch).
//   4  backtest-service.js carries the Coinbase-only guard.
//   5  watchdog.js routes per-trade via assertExchangeSupported (not
//      requireAdapterFor, not a sweep-level bail).
//   6  trade_logs INSERT INVENTORY — the ONLY insert sites are the 4 known ones in
//      lib/execute-trade-mcp.js. A new insert path would silently inherit the DB
//      default instead of stamping from config; that is a violation.
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push2-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
// Commit A shipped this gate REPORT-ONLY (it inspects Commit B's wiring, which did
// not exist yet). Commit B flips this to false and the gate enforces.
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'scripts']);

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => { try { readFileSync(path.join(ROOT, rel)); return true; } catch { return false; } };

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// Walk repo source files (excluding scripts/ so this gate's own mocks never match).
const files = [];
(function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name));
    } else if (/\.(js|mjs|cjs|sql)$/.test(ent.name)) {
      files.push(path.join(dir, ent.name));
    }
  }
})(ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── 1. Migration 060 ────────────────────────────────────────────────────────
const MIG = 'supabase/migrations/060-exchange-columns.sql';
if (!exists(MIG)) {
  check('060 migration exists', false, MIG + ' not found');
} else {
  const sql = read(MIG).replace(/\s+/g, ' ');
  check('060 adds strategy_config.exchange (not null default coinbase)',
    /alter table strategy_config add column if not exists exchange text not null default 'coinbase'/i.test(sql),
    'per-table add-column statement must exist');
  check('060 adds trade_logs.exchange (not null default coinbase)',
    /alter table trade_logs add column if not exists exchange text not null default 'coinbase'/i.test(sql),
    'per-table add-column statement must exist');
  check('060 adds idx_trade_logs_tenant_exchange',
    /create index if not exists idx_trade_logs_tenant_exchange on trade_logs \(tenant_id, exchange\)/i.test(sql));
}

// ── 2. exchange-router.js (behavioural) ─────────────────────────────────────
const ROUTER = 'lib/exchange-router.js';
if (!exists(ROUTER)) {
  check('exchange-router.js exists', false, ROUTER + ' not found');
} else {
  try {
    const mod = await import('../lib/exchange-router.js');
    const hasResolve = typeof mod.resolveExchange === 'function';
    const hasAssert = typeof mod.assertExchangeSupported === 'function';
    check('router exports resolveExchange + assertExchangeSupported', hasResolve && hasAssert);
    check('router does NOT export requireAdapterFor (no dead API)', typeof mod.requireAdapterFor === 'undefined');

    if (hasResolve) {
      const rCb = mod.resolveExchange('COINBASE');
      const rUndef = mod.resolveExchange(undefined);
      const rEmpty = mod.resolveExchange('');
      const rKraken = mod.resolveExchange('kraken');
      check("resolveExchange('coinbase'|undefined|''|'COINBASE') → supported",
        rCb.supported && rCb.exchange === 'coinbase' && rCb.adapter &&
        rUndef.supported && rUndef.exchange === 'coinbase' &&
        rEmpty.supported && rEmpty.exchange === 'coinbase');
      check("resolveExchange('kraken') → unsupported, adapter null",
        !rKraken.supported && rKraken.adapter === null && rKraken.exchange === 'kraken');
    }

    if (hasAssert) {
      // 🟢 AM63 (Push 4) — 'kraken' gained a provider, so the allowlist widened
      // and the assert now ACCEPTS it. The negative control (a real unknown still
      // throws) is kept deliberately — that is what makes the widened allowlist a
      // contract, not a loosening. Behaviour evolves in the same commit as the
      // router body change (same doctrine as the .toLowerCase() tolerance fix).
      let threwUnknown = false, threwKnown = false, threwUndef = false, threwKraken = false;
      try { mod.assertExchangeSupported('bybit'); } catch { threwUnknown = true; }
      try { mod.assertExchangeSupported('coinbase'); } catch { threwKnown = true; }
      try { mod.assertExchangeSupported(undefined); } catch { threwUndef = true; }
      try { mod.assertExchangeSupported('kraken'); } catch { threwKraken = true; }
      check('assertExchangeSupported throws for a real unknown, passes for coinbase/undefined',
        threwUnknown && !threwKnown && !threwUndef);
      check("assertExchangeSupported ACCEPTS 'kraken' (Push 4 widened allowlist)",
        !threwKraken);
      const msg = (() => { try { mod.assertExchangeSupported('bybit'); return ''; } catch (e) { return e.message; } })();
      check('assertExchangeSupported message is the AM63 loud refusal',
        /\[AM63\]/.test(msg) && /not supported yet/.test(msg));
    }
  } catch (e) {
    check('exchange-router.js imports cleanly', false, e.message);
  }
}

// ── 3. execute-trade-mcp.js wiring ──────────────────────────────────────────
const EXEC = 'lib/execute-trade-mcp.js';
if (!exists(EXEC)) {
  check('execute-trade-mcp.js exists', false, EXEC + ' not found');
} else {
  const src = read(EXEC);
  const liveAt = src.indexOf('const liveInsertPayload');
  const paperAt = src.indexOf('const paperInsertPayload');
  const stampCount = (src.match(/exchange:\s*resolvedExchange/g) || []).length;
  check('both payloads stamp exchange: resolvedExchange', stampCount >= 2,
    `found ${stampCount} stamp(s), need 2 (liveInsertPayload + paperInsertPayload)`);
  check('resolvedExchange is resolved from stratCfg',
    // AM63 Push 3 wraps this in .toLowerCase() for shape convergence; the check
    // tolerates the wrapper so the push2 gate does not trip on the push3 bundle.
    /const\s+resolvedExchange\s*=\s*\(?\s*stratCfg\?\.exchange/.test(src));
  // Safety nets: the shared regex must include `exchange`.
  const netRegexes = src.match(/\/\((?:[^)]*)\)\/i\.test\(insertError[^)]*\)/g) || [];
  const exchangeNets = netRegexes.filter((r) => /exchange/.test(r)).length;
  check('both safety nets include exchange in the shared regex', exchangeNets >= 2,
    `found ${exchangeNets} safety-net regex(es) covering exchange, need 2`);
  const delCount = (src.match(/delete without\.exchange/g) || []).length;
  check('both safety nets delete without.exchange', delCount >= 2, `found ${delCount}, need 2`);
  // The blind spot: the stratCfg select (the cfgRow lookup) MUST cover exchange.
  // Anchor on the `cfgRow` destructuring so we never match an unrelated
  // strategy_config select elsewhere in the file.
  const selMatch = src.match(/data: cfgRow[\s\S]{0,120}?\.from\('strategy_config'\)\s*\.select\('([^']*)'\)/);
  check("stratCfg select covers 'exchange'",
    !!selMatch && /\bexchange\b/.test(selMatch[1]),
    selMatch ? `select = '${selMatch[1]}'` : 'stratCfg cfgRow select not found');
  check('stratCfg select has a PGRST204 fallback (pre-060 safe)',
    /PGRST204/.test(src) && /strategy_config select degraded/.test(src));
  check('live payload precedes paper payload (insert order sanity)', liveAt > -1 && paperAt > liveAt);
}

// ── 4. backtest-service guard ───────────────────────────────────────────────
const BT = 'lib/backtest-service.js';
if (!exists(BT)) {
  check('backtest-service.js exists', false, BT + ' not found');
} else {
  const src = read(BT);
  check('backtest-service carries the Coinbase-only guard',
    /backtests are Coinbase-only/.test(src) && /\[\s*AM63\s*\]/.test(src));
}

// ── 5. watchdog per-trade routing ───────────────────────────────────────────
const WD = 'workers/watchdog.js';
if (!exists(WD)) {
  check('watchdog.js exists', false, WD + ' not found');
} else {
  const src = read(WD);
  const imports = /import\s*\{[^}]*assertExchangeSupported[^}]*\}\s*from\s*'\.\.\/lib\/exchange-router\.js'/.test(src);
  check('watchdog imports assertExchangeSupported from exchange-router', imports);
  check('watchdog calls assertExchangeSupported per-trade', /assertExchangeSupported\(openTrade\.exchange\)/.test(src));
  check('watchdog does NOT use requireAdapterFor', !/requireAdapterFor/.test(src));
  check('watchdog logs the per-trade unsupported-venue line',
    /on unsupported venue/.test(src) && /sweep skipped for this trade/.test(src));
}

// ── 6. trade_logs INSERT inventory ──────────────────────────────────────────
// Every `.from('trade_logs') ... .insert(` site in the repo. Push 2 permits
// EXACTLY the 4 known execute-trade-mcp sites; anything else = violation.
const insertSites = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  const re = /\.from\(\s*['"]trade_logs['"]\s*\)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tail = s.slice(m.index, m.index + 160);
    if (/\.insert\s*\(/.test(tail)) {
      insertSites.push({ file: rel(f), line: s.slice(0, m.index).split('\n').length });
    }
  }
}
const execSites = insertSites.filter((x) => x.file === EXEC);
const foreignSites = insertSites.filter((x) => x.file !== EXEC);
// 🟢 Push 7 evolution: the KRF LIVE lane added its OWN insert pair (primary +
// additive-column retry) inside execute-trade-mcp — the same safety-net pattern
// as the 4 original sites, never a foreign file. Inventory = 6 known sites.
check('trade_logs insert inventory = 6 known sites in execute-trade-mcp.js (4 original + 2 KRF LIVE)',
  execSites.length === 6 && foreignSites.length === 0,
  `execute-trade-mcp=${execSites.length} (want 6), other files=${foreignSites.length} (want 0)` +
  (foreignSites.length ? ` → ${foreignSites.map((x) => `${x.file}:${x.line}`).join(', ')}` : ''));

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 2 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
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
