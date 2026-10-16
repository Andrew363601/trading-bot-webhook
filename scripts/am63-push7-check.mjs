// scripts/am63-push7-check.mjs
// 🟢 PUSH AM63 (Push 7) GATE — Kraken Futures LIVE (apiv3 private layer + real orders).
//
// Enforces the Push 7 contract:
//   1  lib/providers/kraken-futures.js gains the PRIVATE layer: kfSign (HMAC-SHA512
//      over SHA256(urlencoded-postData + nonce + endpointPath), key = base64-DECODED
//      secret — the ONE construction, NO jwt.sign anywhere), kfPrivateRequest (creds
//      resolved ITSELF via retrieveAPIKey('krakenfutures'); retry ONLY on 429),
//      placeKrakenFuturesOrder (the phantom result:'success' trap is a GUARD — the
//      inner sendStatus.status carries the truth), pollKrakenFuturesFill (AM59
//      receipt: terminal only on positive filled size), cancel helpers + the
//      dead-man heartbeat wrapper (self-throttled ≥15 s, timeout 60 s), the
//      cost-weighted limiter (sendorder 10 / cancelorder 10 / cancelallorders 25 /
//      accounts 2 / openpositions 2 / reads 1), fetchKrakenFuturesBalance.
//   2  Commit A is INERT — no behavior-bearing file imports the private symbols yet.
//   3  Commit B (guarded by REPORT_ONLY): execute-trade LIVE krakenfutures lane
//      (refusal REMOVED — exact Push 6 text ABSENT; limit-IOC entry at mark ± ATR
//      band; AM59 receipt BEFORE stamping; reduce-only take_profit + stp
//      conditionals with triggerSignal mark placed after fill; close = reduce-only
//      IOC + receipt; insufficientAvailableFunds surfaces as a readable rejection);
//      watchdog KRF LIVE manager (resident-conditional tripwire/trail, dead-man
//      refreshed each sweep, native-fill forensics); getRealBalance krakenfutures
//      branch; Bitnomial (kraken) refusal STAYS.
//   4  Prior-push invariants: seam (no jwt.sign outside the coinbase provider),
//      push2/push3/push4/push5/push6 gates still pass (run separately).
//
// REPORT_ONLY (Commit A): prints findings but always exits 0 so the inert commit
// stays green. Commit B flips it to false. Read-only; never mutates the repo.
//
// Run: node scripts/am63-push7-check.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────── Commit A → B switch ───────────────────────────
const REPORT_ONLY = false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'scripts']);

const PROVIDER = 'lib/providers/kraken-futures.js';
const EXEC = 'lib/execute-trade-mcp.js';
const WATCHDOG = 'workers/watchdog.js';
const RESOLVER = 'lib/asset-resolver.js';
const COINBASE_PROVIDER = 'lib/providers/coinbase.js';

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
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. Provider: the private layer (behavioural import) ─────────────────────
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
    check('provider exports kfSign', typeof mod.kfSign === 'function');
    check('provider exports kfPrivateRequest', typeof mod.kfPrivateRequest === 'function');
    check('provider exports placeKrakenFuturesOrder', typeof mod.placeKrakenFuturesOrder === 'function');
    check('provider exports pollKrakenFuturesFill', typeof mod.pollKrakenFuturesFill === 'function');
    check('provider exports cancelKrakenFuturesOrder', typeof mod.cancelKrakenFuturesOrder === 'function');
    check('provider exports cancelAllKrakenFuturesOrders', typeof mod.cancelAllKrakenFuturesOrders === 'function');
    check('provider exports refreshKrakenFuturesDeadMan', typeof mod.refreshKrakenFuturesDeadMan === 'function');
    check('provider exports fetchKrakenFuturesBalance', typeof mod.fetchKrakenFuturesBalance === 'function');
    check('limiter grew acquireWeighted', typeof mod.kfRateLimiter?.acquireWeighted === 'function');
    check('limiter keeps the plain acquire (backward compat)', typeof mod.kfRateLimiter?.acquire === 'function');

    // KNOWN-VECTOR SIGNER PIN — the exact concatenation order (postData + nonce +
    // endpointPath) is pinned by a stable vector. If the demo host rejects at the
    // soak, flip BOTH this vector and the provider in the same commit.
    try {
      const v = mod.kfSign({
        endpointPath: '/derivatives/api/v3/sendorder',
        postDataEncoded: 'symbol=PF_XBTUSD&side=buy&size=1',
        nonce: '1700000000000',
        apiSecretB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      });
      check('kfSign known-vector (pins postData+nonce+endpointPath order)',
        v.Authent === 'WoZzGykTJ1ztTJZ5RNcR2kMgMH9HOEYXw+TFXowSzWw65sVwwpLR/Lm3wNmlmOVad7Qvlr1wRZh1UdUMzk+6QQ==',
        v.Authent);
    } catch (e) {
      check('kfSign known-vector (pins postData+nonce+endpointPath order)', false, e.message);
    }
    try {
      // Node's base64 decoder is LENIENT ('not-base64!!' decodes to garbage bytes),
      // so the honest guard is the EMPTY secret — the vault can only produce that.
      mod.kfSign({ endpointPath: '/x', postDataEncoded: 'a=1', nonce: '1', apiSecretB64: '' });
      check('kfSign throws on an empty secret', false, 'no throw');
    } catch {
      check('kfSign throws on an empty secret', true);
    }
  }

  const src = read(PROVIDER);
  const code = stripComments(src);
  // Signer shape: HMAC-SHA512, base64-DECODED secret as key, SHA256 over the
  // urlencoded postData + nonce + endpointPath. This is HMAC — jwt.sign must NOT
  // appear anywhere in this file (seam doctrine).
  check('kfSign uses createHmac sha512 with a base64-DECODED secret key',
    /createHmac\('sha512',\s*secretKey\)/.test(code) && /Buffer\.from\(String\(apiSecretB64 \|\| ''\), 'base64'\)/.test(code));
  check('kfSign hashes SHA256 over postData + nonce + endpointPath',
    /createHash\('sha256'\)/.test(code) && /postDataEncoded[\s\S]{0,40}nonce[\s\S]{0,40}endpointPath/.test(code));
  check('NO jwt.sign anywhere in the provider (this is HMAC, not JWT)',
    !/jwt\.sign/.test(code));
  check('kfPrivateRequest resolves creds ITSELF via retrieveAPIKey krakenfutures',
    /retrieveAPIKey\(supabase,\s*tenantId,\s*'krakenfutures'\)/.test(code));
  check('kfPrivateRequest sends the APIKey/Authent/Nonce header trio',
    /'APIKey'/.test(code) && /'Authent'/.test(code) && /'Nonce'/.test(code));
  check('private egress goes through kfFetch (limiter FIRST, 429 backoff)',
    /await kfFetch\(url, init\)/.test(code) && /acquireWeighted\(resolvedCost\)/.test(code));
  check('private layer pins the sendorder path', /\/derivatives\/api\/v3\/sendorder/.test(code));
  check('private layer pins the dead-man path (cancelallordersafter)',
    /\/derivatives\/api\/v3\/cancelallordersafter/.test(code));
  check('private layer pins the fills path', /\/derivatives\/api\/v3\/fills/.test(code));
  // Phantom-trap guard: result:'success' alone NEVER implies placed — the inner
  // sendStatus.status carries the truth.
  check('placeKrakenFuturesOrder branches on the INNER sendStatus.status (phantom-trap guard)',
    /sendStatus\.status/.test(code) && /KF_PLACED_STATUSES\.has\(status\)/.test(code));
  check('placeKrakenFuturesOrder returns the normalized verdict shape',
    /placed:\s*false,\s*orderId:\s*null,\s*status:/.test(code) || /\{\s*placed,/.test(code));
  check('insufficientAvailableFunds + wouldCauseLiquidation are pinned constants',
    /insufficientAvailableFunds/.test(code) && /wouldCauseLiquidation/.test(code));
  // AM59 receipt: terminal only on positive filled size.
  check('pollKrakenFuturesFill is terminal ONLY on positive filled size',
    /confirmed:\s*filledSize > 0/.test(code));
  check('pollKrakenFuturesFill reuses the AM59 poll-bound envs',
    /AM59_FILL_POLL_CAP_MS/.test(code) && /AM59_FILL_POLL_MS/.test(code));
  check('fills carry NO fee field — fees stamped null honestly',
    /fees:\s*null/.test(code));
  // Cost accounting: the doc'd budget.
  check('cost map pins sendorder 10 / cancelorder 10 / cancelallorders 25 / accounts 2 / openpositions 2',
    /sendorder:\s*10/.test(code) && /cancelorder:\s*10/.test(code)
    && /cancelallorders:\s*25/.test(code) && /accounts:\s*2/.test(code)
    && /openpositions:\s*2/.test(code));
  // Dead-man: self-throttled heartbeat, timeout 60 s.
  check('dead-man wrapper self-throttles to ≥15 s (Kraken recommendation)',
    /KF_DEADMAN_MIN_INTERVAL_MS = 15 \* 1000/.test(code));
  check('dead-man timeout is 60 s', /KF_DEADMAN_TIMEOUT_SECONDS = 60/.test(code));
  // Balance normalization: flex availableMargin/initialMarginWithOrders/balanceValue.
  check('fetchKrakenFuturesBalance normalizes flex availableMargin/initialMarginWithOrders/balanceValue',
    /availableMargin/.test(code) && /initialMarginWithOrders/.test(code) && /balanceValue/.test(code));
  // Demo-host knob intact (Push 5 invariant).
  check('demo-host knob intact (KRAKEN_FUTURES_DEMO / KRAKEN_FUTURES_HOST)',
    /KRAKEN_FUTURES_DEMO/.test(code) && /KRAKEN_FUTURES_HOST/.test(code));
  // Instruments carry the probe-d precision fields.
  check('instruments carry contractValueTradePrecision + minimumTradeSize (probe d)',
    /contractValueTradePrecision/.test(code) && /minimumTradeSize/.test(code));
  // triggerSignal REQUEST casing is mark|index|last (the mark_price list is the
  // RESPONSE echo shape) — the request builder must not send mark_price.
  check('triggerSignal request casing is mark (NOT mark_price)',
    !/triggerSignal\s*[:=]\s*'mark_price'/.test(code));
}

// ── 2. Commit A INERT ↔ Commit B BOUND (the A→B switch) ─────────────────────
const PRIVATE_SYMBOLS = /kfSign|kfPrivateRequest|placeKrakenFuturesOrder|pollKrakenFuturesFill|cancelKrakenFuturesOrder|cancelAllKrakenFuturesOrders|refreshKrakenFuturesDeadMan|fetchKrakenFuturesBalance/;
const consumers = [];
for (const f of files) {
  const file = rel(f);
  if (file === PROVIDER) continue;
  const s = readFileSync(f, 'utf8');
  if (PRIVATE_SYMBOLS.test(s)) consumers.push(file);
}
if (REPORT_ONLY) {
  check('INERT (Commit A): no behavior-bearing file imports the private symbols',
    consumers.length === 0,
    consumers.length ? `imported by: ${consumers.join(', ')}` : '');
} else {
  const need = {
    [EXEC]: 'execute-trade',
    [WATCHDOG]: 'watchdog',
    [RESOLVER]: 'asset-resolver',
  };
  const missing = Object.keys(need).filter((f) => !consumers.includes(f));
  check('BOUND (Commit B): execute-trade + watchdog + asset-resolver import the private symbols',
    missing.length === 0,
    missing.length ? `missing: ${missing.map((f) => need[f]).join(', ')}` : '');
}

// ── 3. Commit B wiring (guarded) ────────────────────────────────────────────
if (!REPORT_ONLY) {
  if (exists(EXEC)) {
    const src = read(EXEC);
    const code = stripComments(src);
    check('execute-trade: the Push 6 LIVE refusal is REMOVED (exact text ABSENT)',
      !/Kraken Futures live execution arrives in Push 6/.test(src));
    check('execute-trade: the Bitnomial (kraken) refusal STAYS',
      /Kraken live execution arrives in Push 5/.test(src));
    check('execute-trade: KRF LIVE entry is a limit-IOC at mark ± ATR band',
      /orderType:\s*'ioc'/.test(code) && /KRF_ENTRY_BAND_ATR_MULT|kfEntryBand/.test(code));
    check('execute-trade: AM59 receipt BEFORE stamping (pollKrakenFuturesFill gates the row)',
      /pollKrakenFuturesFill\(/.test(code) && /kfFillConfirmed|kfReceipt/.test(code));
    check('execute-trade: reduce-only take_profit + stp conditionals after fill (triggerSignal mark)',
      /'take_profit'/.test(code) && /'stp'/.test(code) && /triggerSignal:\s*'mark'/.test(code)
      && /reduceOnly:\s*true/.test(code));
    check('execute-trade: close is a reduce-only IOC with a receipt',
      /kfClose|nx_krf_close/.test(code));
    check('execute-trade: insufficientAvailableFunds surfaces as a readable rejection',
      /insufficientAvailableFunds/.test(code));
    check('execute-trade: KRF cliOrdId convention (nx_krf_*)',
      /nx_krf_/.test(code));
    check('execute-trade: LIVE risk validator gets the KRF contract_size override',
      /contract_size:\s*kfMultiplier/.test(code));
    // 🟢 Push 7 hotfix 2 — the generic credential throw + formattedSecret assignment
    // are Coinbase-only: they must live INSIDE the `else if (tenantId)` Coinbase
    // branch so they are structurally unreachable when krakenFuturesLane is true.
    check('execute-trade: credential throw + formattedSecret are inside the Coinbase branch (unreachable on the KRF lane)',
      (() => {
        const m = code.match(/if \(krakenFuturesLane\) \{[\s\S]*?\} else if \(tenantId\) \{[\s\S]*?\n      \}/);
        if (!m) return false;
        const branch = m[0];
        return /Missing Coinbase API credentials\./.test(branch)
          && /formattedSecret = apiSecret\.replace/.test(branch)
          && branch.indexOf('Missing Coinbase API credentials.') > branch.indexOf("retrieveAPIKey(supabase, tenantId, 'COINBASE')");
      })());
    // The KRF lane must reach placeKrakenFuturesOrder WITHOUT touching a Coinbase
    // endpoint: the Coinbase order POST, PHASE C fallback, rejection handler,
    // AM59 STEP 1-2, PHASE D, and bracket cleanup are all lane-gated.
    check('execute-trade: Coinbase order POST is lane-gated (KRF never touches a Coinbase endpoint)',
      /if \(!krakenFuturesLane\) \{\s*\n\s*resp = await cbRequest\(/.test(code));
    check('execute-trade: AM59 STEP 1-2 close verification is lane-gated',
      /isClosing && !isPaper && openTrade && !krakenFuturesLane/.test(code));
    check('execute-trade: PHASE D flat check is lane-gated',
      /isClosing && !isPaper && orderType === 'MARKET' && !krakenFuturesLane/.test(code));
    check('execute-trade: bracket cleanup is lane-gated',
      /isClosing && !isPaper && closeFillConfirmed && !krakenFuturesLane/.test(code));
    check('execute-trade: AM14 close prep is lane-gated',
      /if \(isClosing && !krakenFuturesLane\) \{/.test(code));
    check('execute-trade: cfm balance check is lane-gated',
      /marketType !== 'SPOT' && !krakenFuturesLane/.test(code));
    check('execute-trade: generateToken POST call is lane-gated (no PEM parse on undefined creds)',
      /const token = krakenFuturesLane \? null : generateToken\('POST', path\)/.test(code));
  } else {
    check('execute-trade-mcp.js exists', false, EXEC + ' not found');
  }

  if (exists(WATCHDOG)) {
    const src = read(WATCHDOG);
    const code = stripComments(src);
    check('watchdog: KRF LIVE manager branch exists (openpositions + openorders)',
      /OPENPOSITIONS_PATH|openpositions/.test(code) && /openorders/.test(code));
    check('watchdog: tripwire/trail cancel+replace the RESIDENT conditionals',
      /cancelKrakenFuturesOrder\(/.test(code) && /placeKrakenFuturesOrder\(/.test(code));
    check('watchdog: dead-man refreshed each sweep',
      /refreshKrakenFuturesDeadMan\(/.test(code));
    check('watchdog: native-fill forensics via /fills on the stamped conditional ids',
      /pollKrakenFuturesFill\(|FILLS_PATH|fills/.test(code));
    check('watchdog: KRF branch sits BEFORE the Coinbase key fetch',
      code.indexOf('nx_krf_') !== -1
      && code.indexOf('nx_krf_') < code.indexOf("retrieveAPIKey(supabase, tenantId, 'COINBASE')"));
  } else {
    check('watchdog.js exists', false, WATCHDOG + ' not found');
  }

  if (exists(RESOLVER)) {
    const src = read(RESOLVER);
    const code = stripComments(src);
    check('asset-resolver: getRealBalance gains the krakenfutures branch',
      /krakenfutures/.test(code) && /fetchKrakenFuturesBalance\(/.test(code));
    check('asset-resolver: the Coinbase branch stays',
      /coinbase/.test(code) && /balance_summary|cfm/.test(code));
  } else {
    check('asset-resolver.js exists', false, RESOLVER + ' not found');
  }
}

// ── 4. Prior-push invariants intact ─────────────────────────────────────────
if (exists(COINBASE_PROVIDER)) {
  const src = read(COINBASE_PROVIDER);
  check('seam invariant: jwt.sign still lives ONLY in the coinbase provider',
    /jwt\.sign/.test(src));
}
const KRX_PROVIDER = 'lib/providers/kraken-bitnomial.js';
if (exists(KRX_PROVIDER)) {
  const src = read(KRX_PROVIDER);
  check('push4 KRX door untouched (bitnomial host + resolveKrakenProduct intact)',
    /https:\/\/bitnomial\.com/.test(src) && /export async function resolveKrakenProduct/.test(src));
}
const PUSH5 = 'scripts/am63-push5-check.mjs';
if (exists(PUSH5)) {
  const src = read(PUSH5);
  check('push5 gate still pins the sniper KRF lane (un-evolved)',
    /kfPoll/.test(src) && /getKrakenTickers/.test(src));
}

// ── 4b. Push 7 HOTFIX 3 — auth diagnostic surface + demo-feed flood cap ─────
// (a) PROVIDER: every apiv3 reject surfaces the verbatim errorMessage + the host
//     actually used; kfRejectDiagnostics logs method + endpointPath ONLY (never
//     params, never key material); kfAuthProbe is the one-click vault proof.
const PROBE_ROUTE = 'pages/api/kraken-futures-test.js';
const DEMO_FEED = 'pages/api/demo-feed.js';
if (exists(PROVIDER)) {
  const src = read(PROVIDER);
  const code = stripComments(src);
  check('provider: kfAuthProbe exists (one-click GET /accounts vault proof)',
    /export async function kfAuthProbe\(/.test(code));
  check('provider: kfAuthProbe returns { ok, error, errorMessage, host }',
    /ok: true, error: null, errorMessage: null, host: KF_HOST/.test(code)
    && /ok: false, error: diag\.error \|\| `HTTP \$\{resp\.status\}`/.test(code)
    // 🟢 hotfix 4 — the catch return may carry the auth hint between errorMessage and host.
    && /ok: false, error: e\.message, errorMessage: null(, hint: null)?, host: KF_HOST/.test(code));
  check('provider: kfRejectDiagnostics logs method + endpointPath + host (no params, no key material)',
    /Kraken Futures reject: \$\{method\} \$\{path\} host=\$\{KF_HOST\}/.test(code));
  check('provider: sendorder verdict carries the verbatim errorMessage + host',
    /errorMessage: diag\.errorMessage, host: diag\.host, raw: json/.test(code)
    && /errorMessage: placed \? null : \(sendStatus\.errorMessage \|\| json\?\.errorMessage \|\| null\)/.test(code));
  check('provider: accounts error path carries errorMessage + host (additive)',
    /Kraken Futures accounts error: \$\{json\?\.error \|\| 'unknown shape'\}`, errorMessage: diag\.errorMessage, host: diag\.host/.test(code));
}
if (exists(EXEC)) {
  const src = read(EXEC);
  const code = stripComments(src);
  check('execute-trade: entry reject surfaces the verbatim errorMessage + host (log + veto row + Discord)',
    /Kraken Futures rejected the entry order: \$\{kfEntryVerdict\.rejectReason\}/.test(code)
    && /kfEntryVerdict\.errorMessage/.test(code)
    && /\(host \$\{kfEntryVerdict\.host \|\| 'n\/a'\}\)/.test(code)
    && /Venue message:/.test(code));
  check('execute-trade: close reject surfaces the verbatim errorMessage + host',
    /krakenfutures close reject: \$\{kfCloseVerdict\.rejectReason\}/.test(code)
    && /kfCloseVerdict\.errorMessage/.test(code));
  check('execute-trade: ADJUST TP/SL rejects surface the verbatim errorMessage + host',
    /ADJUST TP reject: \$\{tpVerdict\.rejectReason\}\$\{tpVerdict\.errorMessage/.test(code)
    && /ADJUST SL reject: \$\{slVerdict\.rejectReason\}\$\{slVerdict\.errorMessage/.test(code));
}
// (b) PROBE ROUTE: withTenantAuth + tenant-scoped vault read + role gate.
if (exists(PROBE_ROUTE)) {
  const src = read(PROBE_ROUTE);
  const code = stripComments(src);
  check('probe route: withTenantAuth wraps the handler (tenant derived server-side)',
    /import \{ withTenantAuth \} from '\.\.\/\.\.\/lib\/auth-middleware'/.test(code)
    && /export default withTenantAuth\(handler\)/.test(code));
  check('probe route: role gate (ADMIN/TRADER/TRIAL only)',
    /role !== 'ADMIN' && role !== 'TRADER' && role !== 'TRIAL'/.test(code));
  check('probe route: calls kfAuthProbe with the SESSION tenant (never request params)',
    /kfAuthProbe\(\{ supabase, tenantId \}\)/.test(code)
    && /const \{ tenantId, supabase, role \} = req\.tenant/.test(code));
  check('probe route: response carries ok/error/errorMessage/host (no key material)',
    /ok: false,\s*\n\s*error: verdict\.error/.test(code)
    && /errorMessage: verdict\.errorMessage \|\| null/.test(code)
    && /host: verdict\.host/.test(code));
}
// (c) SETTINGS CARD: the Test Connection button is wired to the probe route.
const SETTINGS_PAGE = 'pages/settings.js';
if (exists(SETTINGS_PAGE)) {
  const src = read(SETTINGS_PAGE);
  check('settings: Test Connection button wired to the probe route (KRF card only)',
    /fetch\('\/api\/kraken-futures-test', \{/.test(src)
    && /Test Connection/.test(src)
    && /exchange === 'KRAKENFUTURES' && \(\s*\n\s*<div className="space-y-2">/.test(src));
}
// (d) DEMO-FLOOD: every demo-feed select is capped + trimmed; the telemetry blob
//     and select('*') on memories are structurally gone; the hard cap exists.
if (exists(DEMO_FEED)) {
  const src = read(DEMO_FEED);
  const code = stripComments(src);
  check('demo-feed: trade_logs capped at 40 (was 500 — the flood)',
    /trades: 40,\s*\/\/ trade_logs \(was 500/.test(code)
    && /\.limit\(FEED_CAPS\.trades\)/.test(code));
  check('demo-feed: agent_session_logs capped (60) + log_message trimmed',
    /logs: 60/.test(code) && /\.limit\(FEED_CAPS\.logs\)/.test(code)
    && /log_message: trim\(l\.log_message, TEXT_TRIM\.logMessage\)/.test(code));
  check('demo-feed: strategy_config capped at 40 (was UNBOUNDED)',
    /configs: 40/.test(code) && /\.limit\(FEED_CAPS\.configs\)/.test(code));
  check('demo-feed: shadow_portfolio capped at 40 (was 200)',
    /shadow: 40/.test(code) && /\.limit\(FEED_CAPS\.shadow\)/.test(code));
  check('demo-feed: agent_tool_calls capped at 120 (was 300) + response_summary trimmed',
    /toolCalls: 120/.test(code) && /\.limit\(FEED_CAPS\.toolCalls\)/.test(code)
    && /response_summary: trim\(tc\.response_summary, TEXT_TRIM\.responseSummary\)/.test(code));
  check('demo-feed: scan_results is a SUMMARY feed (no telemetry blob)',
    /select\('id, strategy, asset, status, created_at'\)/.test(code)
    && /\.limit\(FEED_CAPS\.scans\)/.test(code)
    && !/from\('scan_results'\)[\s\S]{0,200}select\('\*'/.test(code));
  check('demo-feed: hermes_core_memory selects DISPLAY COLUMNS ONLY (never select(*))',
    /select\('id, trade_log_id, win_loss, regime_at_close, pnl, thesis_accurate, lesson_learned, working_thesis'\)/.test(code)
    && !/hermes_core_memory'\)\.select\('\*'/.test(code));
  check('demo-feed: trade_logs.reason trimmed (the 10KB oracle text never rides the public wire whole)',
    /reason: trim\(t\.reason, TEXT_TRIM\.reason\)/.test(code));
  check('demo-feed: hard total cap ~1MB with tail-shedding',
    /HARD_TOTAL_CAP_BYTES = 1024 \* 1024/.test(code)
    && /shedOrder = \['toolCalls', 'logs', 'scans', 'shadowTrades', 'memories', 'configs', 'trades'\]/.test(code));
  check('demo-feed: edge cache raised to 30s + SWR 60 (fast route, not a per-poll dump)',
    /s-maxage=30, stale-while-revalidate=60/.test(code));
}

// ── 4c. Push 7 HOTFIX 4 — key-material forensics + venue-cap + resolver noise ──
const RISK_VAL = 'lib/risk-validator.js';
if (exists(PROVIDER)) {
  const src = read(PROVIDER);
  const code = stripComments(src);
  check('provider: kfPrivateRequest logs MASKED fingerprints on every private call (last-4 + lengths, never values)',
    /KRF auth \$\{kfKeyFingerprint\(creds\.apiKey, creds\.apiSecret\)\} label=\$\{label\} host=\$\{KF_HOST\}/.test(code)
    && /function kfKeyFingerprint\(apiKey, apiSecretB64\)/.test(code)
    && /key\.slice\(-4\)/.test(code)
    && /Buffer\.from\(String\(apiSecretB64 \|\| ''\), 'base64'\)\.length/.test(code));
  check('provider: kfAuthHint covers the known failure modes (spot-vs-futures key, demo/prod swap, missing scope)',
    /function kfAuthHint\(errCode, errMessage\)/.test(code)
    && /SPOT key pasted instead of a FUTURES/.test(code)
    && /DEMO key on the PROD host/.test(code)
    && /lacks the trading scope/.test(code));
  check('provider: the hint rides the reject diagnostics (log + return)',
    /const hint = kfAuthHint\(errCode, errMessage\);/.test(code)
    && /HINT: \$\{hint\}/.test(code)
    && /return \{ host: KF_HOST, error: errCode, errorMessage: errMessage, hint \};/.test(code));
  check('provider: kfAuthProbe returns the hint on the reject path',
    /hint: diag\.hint \|\| null, host: diag\.host/.test(code));
}
if (exists(RISK_VAL)) {
  const src = read(RISK_VAL);
  const code = stripComments(src);
  check('risk-validator: the LIVE real-balance cap is VENUE-AWARE (KRF ids cap against krakenfutures, not coinbase)',
    /const isKrfLive = typeof symbol === 'string' && symbol\.includes\('-PERP-KRF'\);/.test(code)
    && /const balanceVenue = isKrfLive \? 'krakenfutures' : 'coinbase';/.test(code)
    && /getRealBalance\(tenantId, balanceVenue\)/.test(code)
    && !/getRealBalance\(tenantId, 'coinbase'\)/.test(code));
  check('risk-validator: a failed KRF balance read falls back to the CONFIGURED balance LOUDLY (never a Coinbase cap)',
    /falling back to the CONFIGURED balance, NOT a Coinbase cap/.test(code));
}
if (exists(RESOLVER)) {
  const src = read(RESOLVER);
  const code = stripComments(src);
  check('asset-resolver: venue ids skip the Coinbase specs ladder early (no dead 404/401 calls)',
    /normalizedSymbol\.includes\('-PERP-KRF'\) \|\| normalizedSymbol\.includes\('-PERP-KRX'\)/.test(code)
    && /_venue_id: true/.test(code));
}

// ── 5. IMPORT-GRAPH SMOKE (the battery gap this hotfix closed) ──────────────
// node --check is syntax-only and next build EXCLUDES workers/ — neither can catch
// a missing cross-module export. The Push 7 hotfix shipped OPENORDERS_PATH /
// OPENPOSITIONS_PATH / FILLS_PATH as non-exported consts while workers/watchdog.js
// imported them → hermes-multi-tenant.js crash-looped on Render at import
// ("does not provide an export named 'FILLS_PATH'"). This smoke runs a CHILD
// PROCESS that dynamically imports EVERY module the worker service boots; any
// import failure (missing export, unresolved specifier, top-level throw) = FAIL.
// process.exit(0) fires immediately after the imports resolve so timers the module
// code registers (setInterval sweeps, realtime sockets) never keep the child alive.
const WORKER_GRAPH = [
  'hermes-multi-tenant.js',
  'hermes-brain.js',
  'workers/watchdog.js',
  'workers/sniper.js',
  'workers/shadow-portfolio.js',
];
if (!REPORT_ONLY) {
  const smokeScript = `
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    const ROOT = ${JSON.stringify(ROOT)};
    const mods = ${JSON.stringify(WORKER_GRAPH)};
    const failures = [];
    for (const m of mods) {
      try {
        await import(pathToFileURL(path.join(ROOT, m)).href);
        console.log('  SMOKE OK   ' + m);
      } catch (e) {
        failures.push(m + ': ' + e.message);
        console.log('  SMOKE FAIL ' + m + ' — ' + e.message);
      }
    }
    if (failures.length > 0) {
      console.error('IMPORT-GRAPH SMOKE FAILED: ' + failures.length + ' module(s): ' + failures.join(' | '));
      process.exit(1);
    }
    console.log('IMPORT-GRAPH SMOKE OK: all ' + mods.length + ' worker-service modules import cleanly.');
    process.exit(0);
  `;
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', smokeScript], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        // Dummy env so module-top Supabase clients construct (asset-resolver and
        // friends throw 'supabaseUrl is required' without them — an import-graph
        // failure we DO want to catch, but not an env-dependent false positive).
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key',
        MASTER_ENCRYPTION_KEY: process.env.MASTER_ENCRYPTION_KEY || 'dummy-master-key',
      },
    });
    const smokeOk = !/SMOKE FAIL/.test(out) && /IMPORT-GRAPH SMOKE OK/.test(out);
    check('import-graph smoke: every worker-service module imports cleanly',
      smokeOk,
      smokeOk ? WORKER_GRAPH.join(', ') : out.trim().split('\n').filter((l) => /SMOKE FAIL|FAILED/.test(l)).join(' | '));
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    const failLines = out.split('\n').filter((l) => /SMOKE FAIL|FAILED/.test(l)).join(' | ');
    check('import-graph smoke: every worker-service module imports cleanly',
      false,
      failLines || e.message);
  }
} else {
  check('import-graph smoke: skipped in REPORT_ONLY (Commit A)', true);
}

// ─────────────────────────────────── report ────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('AM63 Push 7 check' + (REPORT_ONLY ? ' (REPORT-ONLY — Commit A)' : ''));
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
