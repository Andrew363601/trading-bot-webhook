// scripts/am73-check.mjs
// 🟢 AM73 GATE — order-readiness surfacing + $0-balance veto.
//
//   1  lib/order-readiness.js: deriveOrderMode + readinessRows + classifyKrakenSpotReject
//      (BEHAVIORAL vectors).
//   2  lib/providers/kraken-spot.js: validate-aware branch in placeKrakenSpotOrder.
//   3  pages/api/kraken-spot-test.js: {pair, leverage} body + rows + 30s cache.
//   4  lib/execute-trade-mcp.js: logAgentActivity + classifyKrakenSpotReject wiring.
//   5  hermes-brain.js: margin_not_eligible + entry_rejected in nonSuccessStatuses.
//   6  lib/risk-validator.js: $0-balance LIVE veto (BEHAVIORAL vector + positive-budget
//      clamp regression).
//   7  UI: MarketScanner + index.js mode badge + readiness strip.
//   8  Prior gates still green (subprocess: am72 + am69 + am55).
//
// Read-only; never mutates the repo. Run: node scripts/am73-check.mjs

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

console.log('AM73 order-readiness + $0-balance veto check\n');

// ═══════════════════ 1. lib/order-readiness.js ═══════════════════
console.log('── 1. lib/order-readiness.js — mode badge + readiness rows + reject classify ──');
const OR = 'lib/order-readiness.js';
check('order-readiness.js exists', exists(OR));
if (exists(OR)) {
  let m = null;
  try { m = await import(pathToFileURL(path.join(ROOT, OR)).href); }
  catch (e) { check('order-readiness imports cleanly', false, e.message); }

  if (m) {
    // ── deriveOrderMode: the SAME rule the lane uses (leverage > 1 && margin-eligible).
    check('BEHAVIORAL: 1× → CASH order',
      m.deriveOrderMode({ leverage: 1, marginEligible: true }).mode === 'CASH' &&
      m.deriveOrderMode({ leverage: 1, marginEligible: true }).label === 'CASH order');
    check('BEHAVIORAL: >1× + margin-eligible → MARGIN ×N',
      m.deriveOrderMode({ leverage: 5, marginEligible: true }).mode === 'MARGIN' &&
      m.deriveOrderMode({ leverage: 5, marginEligible: true }).label === 'MARGIN ×5');
    check('BEHAVIORAL: >1× + NON-margin pair → CASH (EUR/TX)',
      m.deriveOrderMode({ leverage: 5, marginEligible: false }).mode === 'CASH');
    check('BEHAVIORAL: missing leverage → CASH (honest default)',
      m.deriveOrderMode({}).mode === 'CASH');

    // ── readinessRows shape.
    const rows = m.readinessRows({
      balance: { equity_usd: 123.45, available_margin: 0, margin_level: 0 },
      keyPerms: { query: true, orders: true },
      mode: { mode: 'MARGIN', label: 'MARGIN ×5' },
      lastVerdict: null,
      marginVerified: null,
    });
    check('BEHAVIORAL: readinessRows returns {check, ok, detail} rows',
      Array.isArray(rows) && rows.length >= 4 && rows.every((r) => 'check' in r && 'ok' in r && 'detail' in r));
    check('BEHAVIORAL: balance row ok=true with equity',
      rows.find((r) => r.check === 'Balance')?.ok === true);
    check('BEHAVIORAL: key perms row ok=true when query+orders',
      rows.find((r) => r.check === 'Key perms')?.ok === true);
    check('BEHAVIORAL: MARGIN mode + unverified → margin eligibility ok=null (ECP honesty)',
      rows.find((r) => r.check === 'Margin eligibility')?.ok === null &&
      /unverified until first order/.test(rows.find((r) => r.check === 'Margin eligibility')?.detail || ''));
    check('BEHAVIORAL: MARGIN mode + marginVerified=false → NOT ENABLED',
      m.readinessRows({ mode: { mode: 'MARGIN', label: 'MARGIN ×5' }, marginVerified: false })
        .find((r) => r.check === 'Margin eligibility')?.ok === false);
    check('BEHAVIORAL: CASH mode omits the margin-eligibility row',
      !m.readinessRows({ mode: { mode: 'CASH', label: 'CASH order' } }).some((r) => r.check === 'Margin eligibility'));
    check('BEHAVIORAL: missing balance → honest-absent (ok=null, detail —)',
      m.readinessRows({}).find((r) => r.check === 'Balance')?.ok === null);

    // ── classifyKrakenSpotReject.
    const nonEcp = m.classifyKrakenSpotReject('EGeneral:Permission denied', { asset: 'SOL-SPOT-KRS', leverage: 5 });
    check('BEHAVIORAL: Non-ECP margin reject → margin_not_eligible',
      nonEcp.status === 'margin_not_eligible');
    check('BEHAVIORAL: Non-ECP message carries the ECP copy verbatim',
      /US spot margin requires margin trading enabled on your Kraken account \(ECP status via Kraken Derivatives US\)/.test(nonEcp.message) &&
      /set Leverage 1× for CASH mode/.test(nonEcp.message));
    const funds = m.classifyKrakenSpotReject('EOrder:Insufficient funds', { asset: 'SOL-SPOT-KRS', leverage: 1 });
    check('BEHAVIORAL: insufficient funds → insufficient_funds + its own message',
      funds.status === 'insufficient_funds' && /Fund the Kraken account or run PAPER mode/.test(funds.message));
    const other = m.classifyKrakenSpotReject('EOrder:Invalid price', { asset: 'SOL-SPOT-KRS', leverage: 1 });
    check('BEHAVIORAL: other reject → entry_rejected (generic)',
      other.status === 'entry_rejected');
    check('BEHAVIORAL: a MARGIN reject mentioning margin → margin_not_eligible',
      m.classifyKrakenSpotReject('EOrder:Margin trading not enabled', { asset: 'X', leverage: 3 }).status === 'margin_not_eligible');
  }
}

// ═══════════════════ 2. kraken-spot.js validate-aware branch ═══════════════════
console.log('\n── 2. lib/providers/kraken-spot.js — validate-aware branch ──');
{
  const code = stripComments(read('lib/providers/kraken-spot.js'));
  check('validate-aware branch present (validate ⇒ empty error[] = success)',
    /if \(validate\) \{/.test(code) && /validated: true/.test(code) && /status: 'validated'/.test(code));
  check('validate branch returns txid:null (nothing placed)',
    /validated: true,\s*txid: null/.test(code));
  check('non-validate path still requires a txid',
    /if \(errs\.length > 0 \|\| !txid\) \{/.test(code));
}

// ═══════════════════ 3. kraken-spot-test.js probe extension ═══════════════════
console.log('\n── 3. pages/api/kraken-spot-test.js — readiness probe ──');
{
  const src = read('pages/api/kraken-spot-test.js');
  const code = stripComments(src);
  check('accepts optional {pair, leverage} body', /body\.pair/.test(code) && /body\.leverage/.test(code));
  check('dry-run uses placeKrakenSpotOrder({..., validate: true})', /validate: true/.test(code));
  check('30s negative cache (module-scope Map)', /READINESS_CACHE_TTL_MS = 30 \* 1000/.test(code) && /readinessCache\.set\(/.test(code));
  check('returns structured rows via readinessRows', /readinessRows\(/.test(code) && /rows,/.test(code));
  check('ECP honesty: marginVerified left null on a passing validate', /marginVerified = null/.test(code));
  check('legacy fields preserved (ok/host/tradeBalance/message)', /tradeBalance,/.test(code) && /host: verdict\.host/.test(code));
  check('imports deriveOrderMode + readinessRows from order-readiness', /from '\.\.\/\.\.\/lib\/order-readiness\.js'/.test(src));
}

// ═══════════════════ 4. execute-trade-mcp.js reject classification ═══════════════════
console.log('\n── 4. lib/execute-trade-mcp.js — KSPOT reject classification ──');
{
  const src = read('lib/execute-trade-mcp.js');
  const code = stripComments(src);
  check('imports classifyKrakenSpotReject', /import \{ classifyKrakenSpotReject \} from '\.\/order-readiness\.js'/.test(src));
  check('logAgentActivity helper added (agent_session_logs insert)', /async function logAgentActivity/.test(code) && /from\('agent_session_logs'\)\.insert/.test(code));
  check('KSPOT entry reject classifies + writes risk_veto_log', /classifyKrakenSpotReject\(ksEntryVerdict\.rejectReason/.test(code) && /risk_veto_log'\)\.insert/.test(code));
  check('KSPOT entry reject sends Discord + agent log', /ksReject\.title/.test(code) && /logAgentActivity\(tenantId, 'EXECUTOR'/.test(code));
  check('KSPOT entry reject returns the classified status', /status: ksReject\.status/.test(code));
}

// ═══════════════════ 5. hermes-brain.js nonSuccessStatuses ═══════════════════
console.log('\n── 5. hermes-brain.js — nonSuccessStatuses ──');
{
  const code = stripComments(read('hermes-brain.js'));
  check('margin_not_eligible is a non-success status', /nonSuccessStatuses = \[[^\]]*'margin_not_eligible'/.test(code));
  check('entry_rejected is a non-success status', /nonSuccessStatuses = \[[^\]]*'entry_rejected'/.test(code));
  check('insufficient_funds is a non-success status', /nonSuccessStatuses = \[[^\]]*'insufficient_funds'/.test(code));
}

// ═══════════════════ 6. risk-validator.js $0-balance veto ═══════════════════
console.log('\n── 6. lib/risk-validator.js — $0-balance LIVE veto ──');
{
  const code = stripComments(read('lib/risk-validator.js'));
  check('$0-veto present (LIVE + maxRiskAmount <= 0)', /executionMode === 'LIVE' && maxRiskAmount <= 0/.test(code));
  check('$0-veto message verbatim', /Effective balance \$0\.00 — LIVE trade refused\. Fund the venue or use PAPER\./.test(code));
  check('$0-veto runs BEFORE the clamp (guard precedes riskAmount > maxRiskAmount)',
    code.indexOf('maxRiskAmount <= 0') < code.indexOf('if (riskAmount > maxRiskAmount)'));

  // ── BEHAVIORAL vector: LIVE $0 balance → refused; positive budget → clamp works.
  // NOTE: supabase-js captures `global.fetch` at createClient() time (module import),
  // so the stub MUST be installed BEFORE the dynamic import — otherwise the client
  // keeps node's real fetch and every settings read fails (the am55 pre-existing red).
  // The $0 path is the REAL balance read returning 0 (a configured 0 is falsy → null,
  // which hits the "cannot verify" branch instead). Mirrors am55's vault stub.
  process.env.MASTER_ENCRYPTION_KEY = 'am73-test-master-key';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://am73-test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'am73-test-service-role';
  let v = { ok: false, detail: 'import failed' };
  const realFetch = global.fetch;
  try {
    const json = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
    const settingsRow = {
      tenant_id: 't-am73', account_balance_usd: 10000, risk_per_trade_percent: 1,
      max_position_size_usd: null, max_leverage: null, daily_roi_target_usd: null,
      max_concurrent_trades: null, allowed_assets: null,
    };
    const trade = { side: 'BUY', symbol: 'BTC-USD', entryPrice: 100, slPrice: 97.2, tpPrice: 110, qty: 10, leverage: 1 };
    const assetSpecs = { contract_size: 1 };

    // Install the stub BEFORE importing risk-validator (createClient captures fetch).
    let realBalance = '0';
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('api_keys_vault')) return json(vaultRow);
      if (u.includes('tenant_settings')) return json(settingsRow);
      if (u.includes('cfm/balance_summary')) return json({ balance_summary: { total_balance: { value: realBalance } } });
      if (u.includes('/accounts')) return json({ accounts: [] });
      if (u.includes('trade_logs')) return json([]);
      return json({});
    };

    // A valid EC P-256 key so generateToken() can sign (asset-resolver path).
    const crypto = await import('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const { encryptSecret } = await import(pathToFileURL(path.join(ROOT, 'lib/secrets-manager.js')).href);
    const vaultRow = {
      tenant_id: 't-am73', exchange: 'COINBASE', is_active: true,
      key_encrypted: encryptSecret('am73-api-key', process.env.MASTER_ENCRYPTION_KEY, 't-am73'),
      secret_encrypted: encryptSecret(pem, process.env.MASTER_ENCRYPTION_KEY, 't-am73'),
    };

    const { validateTradeRisk } = await import(pathToFileURL(path.join(ROOT, 'lib/risk-validator.js')).href);

    // $0 real balance → effectiveBalance 0 → maxRisk 0 → veto fires.
    realBalance = '0';
    const zeroRes = await validateTradeRisk('t-am73', trade, { assetSpecs, executionMode: 'LIVE' });
    const zeroOk = zeroRes.approved === false && /Effective balance \$0\.00 — LIVE trade refused/.test(zeroRes.reason || '');

    // Positive real balance ($8.20 → maxRisk $0.082 < risk $28) → clamp still applies.
    realBalance = '8.20';
    const posRes = await validateTradeRisk('t-am73', trade, { assetSpecs, executionMode: 'LIVE' });
    const posOk = posRes.approved === true && posRes.clamped_sl !== null;

    v = { ok: zeroOk && posOk, detail: `zero=${JSON.stringify(zeroRes)} pos=${JSON.stringify(posRes)}` };
  } catch (e) { v.detail = e.message; }
  finally { global.fetch = realFetch; }
  check('BEHAVIORAL: LIVE $0 → refused; positive budget → clamp regression holds', v.ok, v.detail);
}

// ═══════════════════ 7. UI — mode badge + readiness strip ═══════════════════
console.log('\n── 7. UI — mode badge + readiness strip ──');
{
  const ms = read('components/MarketScanner.js');
  check('MarketScanner imports deriveOrderMode', /import \{ deriveOrderMode \} from '\.\.\/lib\/order-readiness\.js'/.test(ms));
  check('MarketScanner renders the mode badge (MODE BADGE)', /MODE BADGE/.test(ms) && /deriveOrderMode\(\{ leverage/.test(ms));
  check('MarketScanner renders the ORDER-READINESS section', /ORDER-READINESS section/.test(ms) && /Order readiness/.test(ms));
  check('MarketScanner fetches the readiness probe', /fetch\('\/api\/kraken-spot-test'/.test(ms) && /body: JSON\.stringify\(\{ pair: selectedAsset\.id/.test(ms));

  const ix = read('pages/index.js');
  check('index.js imports deriveOrderMode', /import \{ deriveOrderMode \} from '\.\.\/lib\/order-readiness\.js'/.test(ix));
  check('index.js card strip renders the mode badge', /Order mode/.test(ix) && /deriveOrderMode\(\{ leverage: Number\.isFinite\(lv\)/.test(ix));
  check('index.js card renders the ORDER-READINESS section', /ORDER-READINESS section/.test(ix) && /activeReadiness/.test(ix));
  check('index.js edit modal renders the mode badge', /MODE BADGE next to the leverage input/.test(ix));
  check('index.js fetches the readiness probe', /fetch\('\/api\/kraken-spot-test'/.test(ix) && /body: JSON\.stringify\(\{ pair: activeAsset/.test(ix));

  const st = read('pages/settings.js');
  check('settings.js renders the readiness rows', /krSpotTestResult\.rows/.test(st) && /Order readiness/.test(st));
  check('settings.js sends a default pair for readiness', /body: JSON\.stringify\(\{ pair: 'BTC-SPOT-KRS', leverage: 1 \}\)/.test(st));
}

// ═══════════════════ 8. Prior gates still green (subprocess) ═══════════════════
console.log('\n── 8. am72 + am69 gates (subprocess) ──');
{
  const { spawnSync } = await import('node:child_process');
  // NOTE: am55 is EXCLUDED — it has a documented PRE-EXISTING red (its supabase stub
  // is installed AFTER the module import, so createClient keeps node's real fetch).
  // The $0-veto + positive-budget clamp regression is covered by the behavioral
  // vector in section 6 instead.
  for (const gate of ['am72-check.mjs', 'am69-check.mjs']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', gate)], { encoding: 'utf8' });
    check(`${gate} green`, r.status === 0, (r.stdout || '').trim().split('\n').slice(-1)[0] || r.stderr);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
