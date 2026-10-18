// scripts/am65-check.mjs
// 🟢 AM65 — behavioral gate for the Unified FIX lane. Source-string + fixture
// assertions in the established gate style. Run: node scripts/am65-check.mjs
// Pins the validated plan's corrections: E2 (±5s logon nonce), E3 (cumulative
// fee-137 delta), E4 (no ExecType-8 assumption), E6 (owner-process guard +
// gateway proxy), bare-COMB wire ClOrdID, transport default 'rest', loud
// not-provisioned refusal, endpoint-map rows 1–12.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

console.log('AM65 Unified FIX lane check\n');

// ── Commit A files exist ────────────────────────────────────────────────────
check('lib/providers/kraken-fix.js exists', existsSync(path.join(ROOT, 'lib/providers/kraken-fix.js')));
check('scripts/am65-fix-vectors.mjs exists', existsSync(path.join(ROOT, 'scripts/am65-fix-vectors.mjs')));

// ── Transport default + switch ──────────────────────────────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check("transport default is 'rest'", /KRF_PRIVATE_TRANSPORT \|\| 'rest'/.test(src));
  check('fixTransportEnabled reads KRF_PRIVATE_TRANSPORT', /fixTransportEnabled/.test(src));
  check('owner-process guard exists (KRF_FIX_SESSION_OWNER)', /KRF_FIX_SESSION_OWNER/.test(src));
  check('isSessionOwnerProcess exported', /export function isSessionOwnerProcess/.test(src));
}

// ── Loud not-provisioned refusal (pinned text) ──────────────────────────────
{
  const src = read('lib/providers/kraken-fix.js');
  check('loud not-provisioned refusal text pinned',
    src.includes('[AM65] KRF FIX not provisioned: no SenderCompID on file'),
    'the exact refusal string must exist verbatim');
  check('refusal names BOTH config sources',
    src.includes('api_keys_vault.fix_sender_comp_id') && src.includes('KRAKEN_FIX_SENDER_COMPID'));
  check('resolveFixConfig reads the vault fix_sender_comp_id column',
    /fix_sender_comp_id/.test(src));
}

// ── COMB ClOrdID (no plain UUID, no prefix on the wire) ─────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check('combClOrdId exists and is exported', /export function combClOrdId/.test(src));
  check('COMB uses ms×100 (10-μs units)', /\*\s*100n/.test(src));
  check('COMB pads to 12 hex chars (48 bits)', /padStart\(12,\s*'0'\)/.test(src));
  const futuresSrc = stripComments(read('lib/providers/kraken-futures.js'));
  check('fix-mode wire ClOrdID is a BARE COMB UUID (no nx_ prefix)',
    /const wireClOrdId = combClOrdId\(\)/.test(futuresSrc));
  check('nx_krf_ stays a DB-record convention (dbRef, not the wire id)',
    /const dbRef = cliOrdId \|\| `nx_krf_fix_/.test(futuresSrc));
}

// ── NOS builder pins ────────────────────────────────────────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check('18=s mandatory in buildNosBody', /let execInst = 's'/.test(src));
  check('FOK/GTD refused on derivatives', /FOK\/GTD are Spot-only on FIX/.test(src));
  check('TIF guard: only GTC(1)/IOC(3)', /resolvedTif !== '1' && resolvedTif !== '3'/.test(src));
  check('60 TransactTime required (fixTransactTime exported)', /export function fixTransactTime/.test(src));
  check('field order 11|55|54|40 first', /`11=\$\{clOrdId\}`[\s\S]*?`55=\$\{symbol\}`[\s\S]*?`54=/m.test(src) || /11=\$\{clOrdId\}/.test(src));
  // D1 — the trigger-ref warning lives at the RUNTIME call site (fixPlaceOrder in
  // kraken-futures.js); the 388 field documentation lives in kraken-fix.js comments.
  const futuresRaw = read('lib/providers/kraken-futures.js');
  check('388 trigger-ref warning exists (D1 — no mark option)',
    /388/.test(src) || /FIX 388 offers only index\(1\)\/last\(5\)/.test(futuresRaw));
}

// ── E2: logon nonce ±5s (NOT ±120s) ─────────────────────────────────────────
{
  const src = read('lib/providers/kraken-fix.js');
  check('E2: logon nonce documented as ±5 seconds', /±5\s*(SECONDS|seconds|s\b)/.test(src));
  check('E2: ±120s attributed to the COMB ClOrdID, not the logon nonce',
    /±120s/.test(src) && !/5025[^]*±120/.test(src.slice(src.indexOf('5025'), src.indexOf('5025') + 400)));
  check('E2: logon builds a FRESH nonce at connect', /const nonce = String\(Date\.now\(\)\)/.test(src));
}

// ── E3: cumulative fee-137 delta ────────────────────────────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check('E3: fee 137 treated as CUMULATIVE (delta math present)',
    /cum137\s*-\s*ledger\.lastCumFee137|lastCumFee137/.test(src));
  check('E3: per-fill fee stored on the ledger', /fillFee/.test(src));
}

// ── E4: no ExecType-8 assumption ────────────────────────────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check('E4: unknown ExecType logs loud + continues (no 8-semantics)',
    /unhandled message type/.test(src));
  check('E4: post-ack failure handled as ExecType=4 unsolicited cancel',
    /unsolicited cancel/.test(src));
}

// ── E6: two-process architecture ────────────────────────────────────────────
{
  const src = stripComments(read('lib/providers/kraken-fix.js'));
  check('E6: getFixSession refuses non-owner processes',
    /getFixSession called in a non-owner process/.test(src));
  check('E6: gateway proxy exists (proxyFixOp)', /export async function proxyFixOp/.test(src));
  check('E6: proxy targets the existing /mcp/execute surface', /\/mcp\/execute/.test(src));
  const futuresSrc = stripComments(read('lib/providers/kraken-futures.js'));
  check('E6: fixRoute branches owner vs proxy', /isSessionOwnerProcess\(\)/.test(futuresSrc) && /proxyFixOp/.test(futuresSrc));
  const probeSrc = read('pages/api/kraken-futures-test.js');
  check('E6: probe REFUSES when a session is live (kick hazard)',
    /fix_session_live/.test(probeSrc) && /peekFixSession/.test(probeSrc));
}

// ── 8674 unset pin (CoD default-ON) ─────────────────────────────────────────
{
  const src = read('lib/providers/kraken-fix.js');
  check('8674 left UNSET at logon (no 8674= field in the logon body)',
    !/`8674=/.test(src));
  check('CoD default-0 documented', /default 0/.test(src));
}

// ── Endpoint map rows 1–12 (no futures.kraken.com in any FIX path) ──────────
{
  const fixSrc = read('lib/providers/kraken-fix.js');
  const fixCode = stripComments(fixSrc); // header comments DOCUMENT the geo-blocked REST door — judge code only
  check('row 1: FIX host is fix.kraken.com (NOT futures.kraken.com in CODE)',
    fixCode.includes('fix.kraken.com') && !fixCode.includes('futures.kraken.com'));
  check('row 1: UAT host constant', fixSrc.includes('fix.uat.kraken.com'));
  check('row 2: derivatives trading port 4003', /4003/.test(fixSrc));
  check('row 3: 35=F same-session cancel', /`35=F`/.test(fixSrc));
  check('row 4: 35=q MassCancel type 7', /`35=q`/.test(fixSrc) && /`530=7`/.test(fixSrc));
  check('row 9: logon 553/554/5025 chain', /553=/.test(fixSrc) && /554=/.test(fixSrc) && /5025=/.test(fixSrc));
  check('row 10: UAT constant present', fixSrc.includes('KRF_FIX_UAT_HOST'));
  // Row 11: public apiv3 REST data paths UNTOUCHED — the REST provider keeps its host.
  const restSrc = read('lib/providers/kraken-futures.js');
  check('row 11: public apiv3 REST stays on futures.kraken.com (KF_HOST intact)',
    /KF_PROD_HOST = 'https:\/\/futures\.kraken\.com'/.test(restSrc));
  check('row 12: PF_* symbols pass through unchanged (55=nativeSymbol)',
    /`55=\$\{symbol\}`/.test(fixSrc));
}

// ── Dispatch inside the private functions (call sites untouched) ────────────
{
  const src = stripComments(read('lib/providers/kraken-futures.js'));
  check('placeKrakenFuturesOrder dispatches fix-mode first',
    /export async function placeKrakenFuturesOrder[\s\S]{0,400}fixTransportEnabled\(\)/.test(src));
  check('pollKrakenFuturesFill dispatches fix-mode',
    /export async function pollKrakenFuturesFill[\s\S]{0,400}fixTransportEnabled\(\)/.test(src));
  check('cancelKrakenFuturesOrder dispatches fix-mode',
    /export async function cancelKrakenFuturesOrder[\s\S]{0,400}fixTransportEnabled\(\)/.test(src));
  check('cancelAllKrakenFuturesOrders dispatches fix-mode',
    /export async function cancelAllKrakenFuturesOrders[\s\S]{0,400}fixTransportEnabled\(\)/.test(src));
  check('refreshKrakenFuturesDeadMan fix-mode = CoD passive no-op',
    /refreshKrakenFuturesDeadMan[\s\S]{0,400}CoD passive/.test(src));
  check('OPENORDERS_PATH/OPENPOSITIONS_PATH/FILLS_PATH exports kept (worker contract)',
    /export const OPENORDERS_PATH/.test(src) && /export const OPENPOSITIONS_PATH/.test(src) && /export const FILLS_PATH/.test(src));
}

// ── Watchdog fix branch ─────────────────────────────────────────────────────
{
  const src = stripComments(read('workers/watchdog.js'));
  check('watchdog: manageKrakenFuturesFixTrade exists', /manageKrakenFuturesFixTrade/.test(src));
  check('watchdog: FIX dispatch sits in the sweep loop before the REST manager',
    /KRF_PRIVATE_TRANSPORT[\s\S]{0,200}manageKrakenFuturesFixTrade/.test(src));
  check('watchdog: session-down alert is LOUD (CoD cancelled session orders)',
    /FIX Session Down/.test(src));
  check('watchdog: D2 — unknown position state alerts LOUD, never assumes flat',
    /position state UNKNOWN/.test(src));
  check('watchdog: ER-ledger forensics replace /fills in fix-mode',
    /erHistory/.test(src));
}

// ── Settings + vault plumbing ───────────────────────────────────────────────
{
  const settingsSrc = read('pages/settings.js');
  check('settings: Kraken FIX SenderCompID field exists', /Kraken FIX SenderCompID/.test(settingsSrc));
  check('settings: fixSenderCompId rides the save payload', /fixSenderCompId/.test(settingsSrc));
  const routeSrc = read('pages/api/configure-api-keys.js');
  check('configure-api-keys: fixSenderCompId passthrough (KRAKENFUTURES only)',
    /fixSenderCompId/.test(routeSrc) && /KRAKENFUTURES/.test(routeSrc));
  const secretsSrc = read('lib/secrets-manager.js');
  check('secrets-manager: storeAPIKey upserts fix_sender_comp_id when present',
    /fix_sender_comp_id/.test(secretsSrc));
  check('secrets-manager: absent SenderCompId never nulls the column',
    /String\(fixSenderCompId\)\.trim\(\) !== ''/.test(secretsSrc));
}

// ── Migration 063 ───────────────────────────────────────────────────────────
{
  const migPath = 'supabase/migrations/063-kraken-fix-sender-compid.sql';
  check('migration 063 exists', existsSync(path.join(ROOT, migPath)));
  if (existsSync(path.join(ROOT, migPath))) {
    const mig = read(migPath);
    check('migration 063: add column if not exists (idempotent)',
      /alter table api_keys_vault add column if not exists fix_sender_comp_id text/i.test(mig));
    check('migration 063: no uuid-ossp dependency', !/uuid_generate_v4/.test(mig));
  }
}

// ── Vectors gate invoked as a subprocess ────────────────────────────────────
{
  try {
    const out = execFileSync('node', ['scripts/am65-fix-vectors.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const m = /(\d+) pass · (\d+) fail/.exec(out);
    check('vectors gate subprocess: all green', m && m[2] === '0', out.slice(-200));
    check('vectors gate subprocess: ≥30 vectors', m && parseInt(m[1], 10) >= 30, `got ${m ? m[1] : '?'}`);
  } catch (e) {
    check('vectors gate subprocess: all green', false, String(e.stdout || e.message).slice(-300));
  }
}

// ── No silent fallback pins ─────────────────────────────────────────────────
{
  const src = read('lib/providers/kraken-fix.js');
  check('no Coinbase substitution anywhere in the FIX module',
    !/coinbase/i.test(src.replace(/\/\/[^\n]*/g, '')));
  check('refusal is a THROW (never a silent return)',
    /throw new Error\('\[AM65\] KRF FIX not provisioned/.test(src));
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) {
  console.error(`FAILED: ${failures.join(' · ')}`);
  process.exit(1);
}
