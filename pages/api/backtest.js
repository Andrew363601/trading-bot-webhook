// pages/api/backtest.js
// 🟢 PUSH AM46 — Strategy Studio Backtest API
// 🟢 PUSH AM46b — backtest_results persistence fix + cooldown parity

import { withTenantAuth } from '../../lib/auth-middleware.js';
import { hasStudioAccess } from '../../lib/entitlements.js';
import { runBacktest } from '../../lib/backtester.js';
import { resolveGranularity, normalizeProduct } from '../../lib/candles.js';

// Global in-memory lock map for tenant backtest concurrency
if (!global.__tenantBacktestLocks) {
  global.__tenantBacktestLocks = new Set();
}
const tenantLocks = global.__tenantBacktestLocks;

const MAX_RANGE_DAYS = 180;
const MAX_TRIGGER_CANDLES = 60000;
const RUN_TIMEOUT_MS = 60000;

function tfToHorizon(tf) {
  const s = String(tf || '').toUpperCase().trim();
  if (s === 'ONE_MINUTE' || s === '60') return '1M';
  if (s === 'FIVE_MINUTE' || s === '300') return '5M';
  if (s === 'FIFTEEN_MINUTE' || s === '900') return '15M';
  if (s === 'THIRTY_MINUTE' || s === '1800') return '30M';
  if (s === 'ONE_HOUR' || s === '3600') return '1H';
  if (s === 'TWO_HOUR' || s === '7200') return '2H';
  if (s === 'SIX_HOUR' || s === '21600') return '6H';
  if (s === 'ONE_DAY' || s === '86400') return '1D';
  return '5M';
}

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

  // 2. Concurrency Lock: 1 active backtest per tenant
  if (tenantLocks.has(tenantId)) {
    return res.status(409).json({
      error: 'Backtest already running for this tenant. Please wait for the current run to finish.'
    });
  }

  const {
    strategy_id,
    name,
    parameters = {},
    product = 'BTC-USD',
    macro_tf = 'ONE_HOUR',
    trigger_tf = 'FIVE_MINUTE',
    start,
    end,
    fee_rate
  } = req.body || {};

  // 3. Validate Inputs & Dates
  const normProduct = normalizeProduct(product);
  const nowSec = Math.floor(Date.now() / 1000);

  let startEpoch = null;
  let endEpoch = null;

  if (start) {
    startEpoch = typeof start === 'number' ? Math.floor(start) : Math.floor(new Date(start).getTime() / 1000);
  }
  if (end) {
    endEpoch = typeof end === 'number' ? Math.floor(end) : Math.floor(new Date(end).getTime() / 1000);
  } else {
    endEpoch = nowSec;
  }

  // Default start to 30 days prior to end if not specified
  if (!startEpoch || isNaN(startEpoch)) {
    startEpoch = endEpoch - (30 * 86400);
  }

  if (isNaN(endEpoch) || startEpoch >= endEpoch) {
    return res.status(400).json({ error: 'Invalid start or end date range.' });
  }

  const rangeDays = (endEpoch - startEpoch) / 86400;
  if (rangeDays > MAX_RANGE_DAYS) {
    return res.status(400).json({
      error: `Date range of ${rangeDays.toFixed(1)} days exceeds maximum allowed limit of ${MAX_RANGE_DAYS} days.`
    });
  }

  const { granularitySeconds: triggerSec } = resolveGranularity(trigger_tf);
  const estimatedCandles = Math.ceil((endEpoch - startEpoch) / triggerSec);
  if (estimatedCandles > MAX_TRIGGER_CANDLES) {
    return res.status(400).json({
      error: `Estimated ${estimatedCandles} trigger candles exceeds maximum allowed (${MAX_TRIGGER_CANDLES}). Please select a larger timeframe or narrower date range.`
    });
  }

  // 4. Load Strategy Code
  let strategyRecord = null;
  if (strategy_id) {
    const { data, error } = await supabase
      .from('strategy_library')
      .select('id, name, version, code, visibility, tenant_id')
      .eq('id', strategy_id)
      .or(`tenant_id.eq.${tenantId},visibility.eq.public`)
      .maybeSingle();

    if (error) return res.status(500).json({ error: `Strategy lookup failed: ${error.message}` });
    strategyRecord = data;
  } else if (name) {
    const cleanName = String(name).trim().toLowerCase();
    const { data, error } = await supabase
      .from('strategy_library')
      .select('id, name, version, code, visibility, tenant_id')
      .eq('name', cleanName)
      .or(`tenant_id.eq.${tenantId},visibility.eq.public`)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: `Strategy lookup failed: ${error.message}` });
    strategyRecord = data;
  } else if (req.body?.code) {
    // Direct code submission from Builder
    strategyRecord = {
      id: null,
      name: 'ad_hoc_draft',
      version: 1,
      code: req.body.code,
      tenant_id: tenantId
    };
  }

  if (!strategyRecord || !strategyRecord.code) {
    return res.status(404).json({ error: 'Strategy not found or contains no code.' });
  }

  // 5. Execute with Concurrency Lock and Timeout
  tenantLocks.add(tenantId);

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Backtest simulation timed out after 60s')), RUN_TIMEOUT_MS)
    );

    const backtestPromise = runBacktest({
      code: strategyRecord.code,
      parameters,
      product: normProduct,
      macro_tf,
      trigger_tf,
      start: startEpoch,
      end: endEpoch,
      fee_rate
    });

    const result = await Promise.race([backtestPromise, timeoutPromise]);

    const { summary, trades, equity_curve } = result;

    // 6. Persistence
    let runId = null;

    // A. Update strategy_library.latest_backtest if associated with an existing library item
    if (strategyRecord.id) {
      const latestBacktestPayload = {
        executed_at: new Date().toISOString(),
        product: normProduct,
        macro_tf,
        trigger_tf,
        start_epoch: startEpoch,
        end_epoch: endEpoch,
        summary,
        trades: trades.slice(-100), // store up to 100 recent trades in jsonb
        equity_curve: equity_curve.slice(-200)
      };

      await supabase
        .from('strategy_library')
        .update({
          latest_backtest: latestBacktestPayload,
          status: 'backtested',
          updated_at: new Date().toISOString()
        })
        .eq('id', strategyRecord.id);
    }

    // B. Record in backtest_results table (AM46b: mapped strictly to verified OpenAPI columns)
    try {
      const pnlPercent = parseFloat(((summary.total_pnl_usd / 10000) * 100).toFixed(2));
      const horizonLabel = tfToHorizon(trigger_tf);

      const { data: inserted, error: insertError } = await supabase
        .from('backtest_results')
        .insert({
          tenant_id: tenantId,
          asset: normProduct,
          horizon: horizonLabel,
          win_rate: summary.win_rate,
          pnl_percent: pnlPercent,
          profit_factor: summary.profit_factor,
          max_drawdown: summary.max_drawdown_usd,
          is_active: true
        })
        .select('id')
        .maybeSingle();

      if (!insertError && inserted?.id) {
        runId = inserted.id;
      } else if (insertError) {
        console.warn('[BACKTEST API] backtest_results insert returned error:', insertError.message);
      }
    } catch (e) {
      console.warn('[BACKTEST API] Legacy backtest_results insert skipped:', e.message);
    }

    return res.status(200).json({
      summary,
      trades,
      equity_curve,
      run_id: runId
    });
  } catch (err) {
    console.error(`[BACKTEST API ERROR] tenant=${tenantId}:`, err.message);
    return res.status(500).json({
      error: err.message || 'Backtest failed to execute.'
    });
  } finally {
    tenantLocks.delete(tenantId);
  }
}

export default withTenantAuth(handler);
