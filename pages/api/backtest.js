// pages/api/backtest.js
// PUSH AM46 - Strategy Studio Backtest API
// PUSH AM46b - backtest_results persistence fix + cooldown parity
// PUSH AM47 - Refactored as thin wrapper delegating to lib/backtest-service.js

import { withTenantAuth } from '../../lib/auth-middleware.js';
import { hasStudioAccess } from '../../lib/entitlements.js';
import { runBacktestForTenant, tenantBacktestLocks } from '../../lib/backtest-service.js';

export { tenantBacktestLocks };

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { tenantId, tier, supabase } = req.tenant;

  // 1. Tier Gate
  if (!hasStudioAccess(tier)) {
    return res.status(403).json({
      error: 'Strategy Studio backtesting requires a PRO plan or higher',
      upgrade: '/plans'
    });
  }

  try {
    const {
      strategy_id,
      strategy_name,
      name,
      parameters,
      product,
      macro_tf,
      trigger_tf,
      start,
      end,
      code,
      fee_rate
    } = req.body || {};

    const result = await runBacktestForTenant(supabase, tenantId, {
      strategy_id,
      strategy_name: strategy_name || name,
      code,
      parameters,
      product,
      macro_tf,
      trigger_tf,
      start,
      end,
      fee_rate
    });

    return res.status(200).json(result);
  } catch (err) {
    const code = err.code || 'UNKNOWN';
    console.error('[BACKTEST API ERROR] tenant=' + tenantId + ' code=' + code + ':', err.message);

    if (code === 'LOCKED') {
      return res.status(409).json({ error: err.message });
    }
    if (code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    if (code === 'RANGE' || code === 'EMPTY_DATA') {
      return res.status(400).json({ error: err.message });
    }
    if (code === 'TIMEOUT') {
      return res.status(504).json({ error: err.message });
    }

    return res.status(500).json({
      error: err.message || 'Backtest failed to execute.'
    });
  }
}

export default withTenantAuth(handler);
