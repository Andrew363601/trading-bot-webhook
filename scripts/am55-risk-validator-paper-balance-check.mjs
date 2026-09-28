// scripts/am55-risk-validator-paper-balance-check.mjs
// 🟢 PUSH AM55 — risk-validator PAPER balance source + clamp-message order.
//   Unit A (PAPER): configured balance 10000, risk 1%, real balance $8.20 ->
//           maxRisk $100, a $28-risk trade passes UNCLAMPED; real balance is
//           NEVER fetched in PAPER.
//   Unit B (LIVE unchanged): same tenant, LIVE -> effective = min(real, configured)
//           = 8.20 -> clamp still applies; real balance IS fetched.
//   Unit C: clamp alert text renders "SL clamped from $2668.47 to $2680.18".
// Run: node scripts/am55-risk-validator-paper-balance-check.mjs

import crypto from 'crypto';

// ── env must be set BEFORE importing modules that build supabase clients ──
process.env.MASTER_ENCRYPTION_KEY = 'am55-test-master-key';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://am55-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'am55-test-service-role';

const { encryptSecret } = await import('../lib/secrets-manager.js');
const { validateTradeRisk } = await import('../lib/risk-validator.js');
const { buildClampDetails } = await import('../lib/clamp-message.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  [' + extra + ']' : ''}`); } else { fail++; console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`); } }

const TENANT = 'tenant-am55';
const REAL_BALANCE = 8.20;

// Valid EC P-256 key so generateToken() can sign (asset-resolver path).
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const vaultRow = {
  tenant_id: TENANT,
  exchange: 'COINBASE',
  is_active: true,
  key_encrypted: encryptSecret('am55-api-key', process.env.MASTER_ENCRYPTION_KEY, TENANT),
  secret_encrypted: encryptSecret(pem, process.env.MASTER_ENCRYPTION_KEY, TENANT)
};

const settingsRow = {
  tenant_id: TENANT,
  account_balance_usd: 10000,
  risk_per_trade_percent: 1,
  max_position_size_usd: null,
  max_leverage: null,
  daily_roi_target_usd: null,
  max_concurrent_trades: null,
  allowed_assets: null
};

let balanceFetchCount = 0;
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.includes('api_keys_vault')) return json(vaultRow);
  if (u.includes('tenant_settings')) return json(settingsRow);
  if (u.includes('cfm/balance_summary')) { balanceFetchCount++; return json({ balance_summary: { total_balance: { value: String(REAL_BALANCE) } } }); }
  if (u.includes('/accounts')) { balanceFetchCount++; return json({ accounts: [] }); }
  if (u.includes('trade_logs')) return json([]);
  return json({});
};

const trade = { side: 'BUY', symbol: 'BTC-USD', entryPrice: 100, slPrice: 97.2, tpPrice: 110, qty: 10, leverage: 1 };
const assetSpecs = { contract_size: 1 };

// ── Unit A (PAPER) ──
console.log('Unit A — PAPER: real-balance cap must NOT apply');
balanceFetchCount = 0;
const paperRes = await validateTradeRisk(TENANT, trade, { assetSpecs, executionMode: 'PAPER' });
ok('PAPER: approved', paperRes.approved === true);
ok('PAPER: no SL clamp (risk $28 < maxRisk $100)', paperRes.clamped_sl === null, `clamped_sl=${paperRes.clamped_sl}`);
ok('PAPER: no qty clamp', paperRes.clamped_qty === null, `clamped_qty=${paperRes.clamped_qty}`);
ok('PAPER: real balance NEVER fetched', balanceFetchCount === 0, `balanceFetchCount=${balanceFetchCount}`);

// ── Unit B (LIVE unchanged) ──
console.log('Unit B — LIVE: real-balance cap still applies');
balanceFetchCount = 0;
const liveRes = await validateTradeRisk(TENANT, trade, { assetSpecs, executionMode: 'LIVE' });
ok('LIVE: real balance WAS fetched', balanceFetchCount > 0, `balanceFetchCount=${balanceFetchCount}`);
ok('LIVE: SL clamped (effective balance = min(8.20, 10000) = 8.20)', liveRes.clamped_sl !== null, `clamped_sl=${liveRes.clamped_sl}`);
ok('LIVE: clamped SL sits ~$0.0082 from entry (maxRisk $0.082 / qty 10)',
  liveRes.clamped_sl !== null && Math.abs((100 - liveRes.clamped_sl) - 0.0082) < 0.0001,
  `dist=${liveRes.clamped_sl != null ? (100 - liveRes.clamped_sl).toFixed(4) : 'n/a'}`);

// ── Unit C (clamp message order) ──
console.log('Unit C — clamp alert text renders the TRUE from→to');
const slMsg = buildClampDetails({ originalSl: 2668.47, originalQty: 5, clampedSl: 2680.18, clampedQty: null });
ok('SL message exact', slMsg.length === 1 && slMsg[0] === 'SL clamped from $2668.47 to $2680.18', slMsg[0]);
ok('SL message is NOT X→X', slMsg[0] !== 'SL clamped from $2680.18 to $2680.18');
const qtyMsg = buildClampDetails({ originalSl: 100, originalQty: 10, clampedSl: null, clampedQty: 3 });
ok('Qty message exact', qtyMsg.length === 1 && qtyMsg[0] === 'Qty clamped from 10 to 3', qtyMsg[0]);
const bothMsg = buildClampDetails({ originalSl: 2668.47, originalQty: 10, clampedSl: 2680.18, clampedQty: 3 });
ok('both clamps -> two details', bothMsg.length === 2, bothMsg.join(' | '));
const noneMsg = buildClampDetails({ originalSl: 100, originalQty: 10, clampedSl: null, clampedQty: null });
ok('no clamps -> empty', noneMsg.length === 0);

global.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
