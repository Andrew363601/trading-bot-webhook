// scripts/am59-fill-verified-close-check.mjs
// 🟢 PUSH AM59 — fill-verified closes (phantom-close bug).
//   Unit A (stuck OPEN): a close order that never reaches FILLED -> close_failed,
//           NO trade_logs close write, loud alert fires, brackets restored.
//   Unit B (filled): a FILLED close -> exit_price = actual avg fill price,
//           exit_fees stamped, orphaned bracket cancelled, position check passes.
//   Unit C (parity): a PAPER close is unchanged (no exchange calls, exit stamped).
// Run: node scripts/am59-fill-verified-close-check.mjs

import crypto from 'crypto';

// ── env must be set BEFORE importing modules that build supabase clients ──
process.env.MASTER_ENCRYPTION_KEY = 'am59-test-master-key';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://am59-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'am59-test-service-role';
process.env.AM59_FILL_POLL_MS = '5';
process.env.AM59_FILL_POLL_CAP_MS = '60';

const TENANT = 'tenant-am59';
const PRODUCT = 'AVP';
const TRADE_ID = 3694;

// Valid EC P-256 key so generateToken() can sign.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const { encryptSecret } = await import('../lib/secrets-manager.js');

const vaultRow = {
  tenant_id: TENANT, exchange: 'COINBASE', is_active: true,
  key_encrypted: encryptSecret('am59-api-key', process.env.MASTER_ENCRYPTION_KEY, TENANT),
  secret_encrypted: encryptSecret(pem, process.env.MASTER_ENCRYPTION_KEY, TENANT)
};

const openTrade = {
  id: TRADE_ID, tenant_id: TENANT, symbol: 'AVP', strategy_id: 'MANUAL', version: 'v1.0',
  side: 'BUY', order_type: 'MARKET', entry_price: 11.10, execution_mode: 'LIVE',
  qty: 5, leverage: 1, market_type: 'FUTURES', tp_price: 11.36, sl_price: 10.97,
  reason: 'test open', exit_price: null, exit_time: null, oco_order_id: 'oco-1',
  params_context: { regime_selected: 'TREND' }
};

const productSpec = {
  future_product_details: {
    contract_size: '1.0',
    perpetual_details: { max_leverage: '10' },
    intraday_margin_rate: { long_margin_rate: '0.1', short_margin_rate: '0.1' }
  },
  base_min_size: '1', base_max_size: '100000', quote_increment: '0.01'
};

// ── fetch stub MUST be installed BEFORE importing modules that build supabase
//    clients (supabase-js captures global fetch at client construction). ──
const realFetch = global.fetch;
let state = null;

function json(obj, ok = true, status = 200) {
  return { ok, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;

  // supabase REST
  if (u.includes('api_keys_vault')) return json(vaultRow);
  if (u.includes('tenant_settings')) return json({ tenant_id: TENANT, notification_webhook_url: 'https://discord.test/hook' });
  if (u.includes('trade_logs')) {
    if (method === 'PATCH' || method === 'POST') {
      state.tradeLogWrites.push({ method, url: u, body });
      return json([{ id: TRADE_ID }]);
    }
    return json([openTrade]);
  }
  if (u.includes('scan_results')) return json([]);
  if (u.includes('strategy_config')) return json({ is_active: true, parameters: {} });
  if (u.includes('usage_logs')) return json([{}]);
  if (u.includes('subscriptions')) return json({ stripe_customer_id: null, status: 'active' });
  if (u.includes('agent_tool_calls')) return json([{}]);

  // discord
  if (u.includes('discord.test')) { state.alerts.push(body); return json({}); }

  // quickchart
  if (u.includes('quickchart.io')) return json({ url: 'https://chart.test/x.png' });

  // public spot candles (api.exchange.coinbase.com)
  if (u.includes('api.exchange.coinbase.com')) return json([]);

  // coinbase product specs
  if (u.includes('/api/v3/brokerage/products/') && !u.includes('/ticker') && !u.includes('/quote_book')) {
    return json(productSpec);
  }
  if (u.includes('/ticker')) return json({ price: '11.20' });

  // coinbase positions
  if (u.includes('/cfm/positions')) {
    return json({ positions: state.positionQty > 0 ? [{ product_id: PRODUCT, number_of_contracts: String(state.positionQty) }] : [] });
  }

  // open orders list
  if (u.includes('/orders/historical/batch')) return json({ orders: state.openOrders });

  // single order status
  if (u.includes('/orders/historical/')) {
    const id = u.split('/orders/historical/')[1];
    const o = state.orderStatus[id] || { status: 'OPEN' };
    return json({ order: { order_id: id, ...o } });
  }

  // batch cancel
  if (u.includes('/orders/batch_cancel')) {
    const ids = body?.order_ids || [];
    state.cancelled.push(...ids);
    state.openOrders = state.openOrders.filter(o => !ids.includes(o.order_id));
    return json({ results: ids.map(id => ({ order_id: id, success: true })) });
  }

  // order placement
  if (u.includes('/api/v3/brokerage/orders')) {
    const coid = body?.client_order_id || '';
    if (coid.startsWith('nx_close')) {
      state.closeOrders.push(coid);
      const id = `close-${state.closeOrders.length}`;
      if (state.closeOrderBehavior === 'filled') {
        state.orderStatus[id] = { status: 'FILLED', average_filled_price: '11.25', total_fees: '0.42', filled_size: '5' };
        state.positionQty = 0; // a real fill flattens the position
      } else {
        state.orderStatus[id] = { status: 'OPEN' };
      }
      return json({ success: true, success_response: { order_id: id } });
    }
    // bracket restore / oco
    state.bracketOrders.push(coid);
    return json({ success: true, success_response: { order_id: `br-${state.bracketOrders.length}` } });
  }

  return json({});
};

const { executeTradeMCP } = await import('../lib/execute-trade-mcp.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  [' + extra + ']' : ''}`); } else { fail++; console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`); } }

function resetState(overrides = {}) {
  state = {
    positionQty: 5,
    openOrders: [{ order_id: 'orphan-tp', status: 'OPEN', order_configuration: { trigger_bracket_gtc: {} } }],
    orderStatus: {},
    closeOrders: [],
    bracketOrders: [],
    cancelled: [],
    alerts: [],
    tradeLogWrites: [],
    closeOrderBehavior: 'open',
    ...overrides
  };
}

const closeArgs = {
  tenant_id: TENANT, symbol: 'AVP', strategy_id: 'MANUAL', version: 'v1.0',
  side: 'SELL', execution_mode: 'LIVE', qty: 5, price: 11.20, leverage: 1,
  market_type: 'FUTURES', order_type: 'MARKET', reduce_only: true,
  trade_id: TRADE_ID, reason: 'MANUAL_UI_CLOSE'
};

// ── Unit A: order stuck OPEN -> close_failed, no write, alert, brackets restored ──
console.log('Unit A — close order stuck OPEN must NOT stamp a phantom close');
resetState({ closeOrderBehavior: 'open' });
const resA = await executeTradeMCP({ ...closeArgs });
ok('A: status is close_failed', resA.status === 'close_failed', `status=${resA.status}`);
ok('A: close_failed flag set', resA.close_failed === true);
ok('A: position_still_open true', resA.position_still_open === true);
ok('A: retried the market close 3x (1 initial + 3 retries)', state.closeOrders.length === 4, `closeOrders=${state.closeOrders.length}`);
const aCloseWrites = state.tradeLogWrites.filter(w => w.body && (w.body.exit_price !== undefined || w.body.exit_time !== undefined));
ok('A: NO trade_logs close write (exit_price/exit_time)', aCloseWrites.length === 0, `writes=${aCloseWrites.length}`);
const aAlert = state.alerts.find(a => JSON.stringify(a).includes('CLOSE FAILED'));
ok('A: loud "CLOSE FAILED" alert fired', !!aAlert);
ok('A: brackets restored on residual (bracket order placed)', state.bracketOrders.length > 0, `bracketOrders=${state.bracketOrders.length}`);

// ── Unit B: FILLED close -> exit_price = fill avg, fees stamped, bracket cancelled ──
console.log('Unit B — confirmed FILLED close stamps the REAL fill price + fees');
resetState({ closeOrderBehavior: 'filled', positionQty: 5 });
const resB = await executeTradeMCP({ ...closeArgs });
ok('B: status is closed_position', resB.status === 'closed_position', `status=${resB.status}`);
ok('B: returned price = actual avg fill (11.25), not decision price (11.20)', resB.price === 11.25, `price=${resB.price}`);
const bCloseWrite = state.tradeLogWrites.find(w => w.body && w.body.exit_price !== undefined);
ok('B: trade_logs close write happened', !!bCloseWrite);
ok('B: exit_price = 11.25 (fill avg)', bCloseWrite?.body?.exit_price === 11.25, `exit_price=${bCloseWrite?.body?.exit_price}`);
ok('B: exit_fees stamped = 0.42', bCloseWrite?.body?.params_context?.exit_fees === 0.42, `exit_fees=${bCloseWrite?.body?.params_context?.exit_fees}`);
ok('B: entry params_context preserved (regime_selected)', bCloseWrite?.body?.params_context?.regime_selected === 'TREND');
ok('B: orphaned bracket cancelled', state.cancelled.includes('orphan-tp'), `cancelled=${state.cancelled.join(',')}`);
ok('B: no CLOSE FAILED alert', !state.alerts.find(a => JSON.stringify(a).includes('CLOSE FAILED')));

// ── Unit C: PAPER close parity (no exchange calls, exit stamped) ──
console.log('Unit C — PAPER close unchanged');
resetState();
const resC = await executeTradeMCP({ ...closeArgs, execution_mode: 'PAPER', price: 11.30 });
ok('C: status is closed_position', resC.status === 'closed_position', `status=${resC.status}`);
ok('C: no exchange close order placed', state.closeOrders.length === 0, `closeOrders=${state.closeOrders.length}`);
const cCloseWrite = state.tradeLogWrites.find(w => w.body && w.body.exit_price !== undefined);
ok('C: paper exit stamped', !!cCloseWrite, `writes=${state.tradeLogWrites.length}`);
ok('C: paper exit_price = decision price 11.30', cCloseWrite?.body?.exit_price === 11.30, `exit_price=${cCloseWrite?.body?.exit_price}`);

// ── Unit D: post-fill bracket sweep catches a straggler the pre-close cancel misses ──
console.log('Unit D — post-fill sweep cancels orphaned orders left after the close');
resetState({
  closeOrderBehavior: 'filled',
  // A stale resting order with NO trigger_bracket_gtc and no matching prefix survives
  // the scoped pre-close cancel — exactly the orphaned TP/SL class from AVP 3694.
  openOrders: [{ order_id: 'stale-limit', status: 'OPEN' }]
});
const resD = await executeTradeMCP({ ...closeArgs });
ok('D: status is closed_position', resD.status === 'closed_position', `status=${resD.status}`);
ok('D: straggler survived pre-close cancel', state.cancelled.includes('stale-limit'), `cancelled=${state.cancelled.join(',')}`);
ok('D: no open orders remain', state.openOrders.length === 0, `openOrders=${state.openOrders.length}`);

global.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
