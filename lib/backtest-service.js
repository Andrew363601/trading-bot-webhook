// lib/backtest-service.js
// PUSH AM47 - Strategy Studio Backtest Orchestration Service

import { runBacktest } from './backtester.js';
import { resolveGranularity, normalizeProduct } from './candles.js';

// Global in-memory lock set for tenant backtest concurrency (shared across API route and chat tool)
if (!global.__tenantBacktestLocks) {
  global.__tenantBacktestLocks = new Set();
}
export const tenantBacktestLocks = global.__tenantBacktestLocks;

const MAX_RANGE_DAYS = 180;
const MAX_TRIGGER_CANDLES = 60000;
const RUN_TIMEOUT_MS = 60000;
const MAX_STORED_CANDLES = 3000;

export function tfToHorizon(tf) {
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

function createServiceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function runBacktestForTenant(supabase, tenantId, {
  strategy_name,
  name,
  strategy_id,
  code,
  parameters = {},
  product = 'BTC-USD',
  macro_tf = 'ONE_HOUR',
  trigger_tf = 'FIVE_MINUTE',
  start,
  end,
  fee_rate
}) {
  if (!tenantId) {
    throw createServiceError('UNAUTHORIZED', 'No tenant context provided.');
  }

  // 1. Concurrency Lock: 1 active backtest per tenant
  if (tenantBacktestLocks.has(tenantId)) {
    throw createServiceError('LOCKED', 'Backtest already running for this tenant. Please wait for the current run to finish.');
  }

  // 2. Validate Inputs & Dates
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

  // Default start to 30 days prior to end if not specified or invalid
  if (!startEpoch || isNaN(startEpoch)) {
    startEpoch = endEpoch - (30 * 86400);
  }

  if (isNaN(endEpoch) || startEpoch >= endEpoch) {
    throw createServiceError('RANGE', 'Invalid start or end date range.');
  }

  const rangeDays = (endEpoch - startEpoch) / 86400;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw createServiceError('RANGE', 'Date range of ' + rangeDays.toFixed(1) + ' days exceeds maximum allowed limit of ' + MAX_RANGE_DAYS + ' days.');
  }

  const { granularitySeconds: triggerSec } = resolveGranularity(trigger_tf);
  const estimatedCandles = Math.ceil((endEpoch - startEpoch) / triggerSec);
  if (estimatedCandles > MAX_TRIGGER_CANDLES) {
    throw createServiceError('RANGE', 'Estimated ' + estimatedCandles + ' trigger candles exceeds maximum allowed (' + MAX_TRIGGER_CANDLES + '). Please select a larger timeframe or narrower date range.');
  }

  // 3. Load Strategy Code
  let strategyRecord = null;
  const lookupName = strategy_name || name;

  if (strategy_id) {
    const { data, error } = await supabase
      .from('strategy_library')
      .select('id, name, version, code, visibility, tenant_id')
      .eq('id', strategy_id)
      .or('tenant_id.eq.' + tenantId + ',visibility.eq.public')
      .maybeSingle();

    if (error) throw createServiceError('LOOKUP_FAILED', 'Strategy lookup failed: ' + error.message);
    strategyRecord = data;
  } else if (lookupName) {
    const cleanName = String(lookupName).trim().toLowerCase();
    const { data, error } = await supabase
      .from('strategy_library')
      .select('id, name, version, code, visibility, tenant_id')
      .eq('name', cleanName)
      .or('tenant_id.eq.' + tenantId + ',visibility.eq.public')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw createServiceError('LOOKUP_FAILED', 'Strategy lookup failed: ' + error.message);
    strategyRecord = data;
  } else if (code) {
    strategyRecord = {
      id: null,
      name: 'ad_hoc_draft',
      version: 1,
      code,
      tenant_id: tenantId
    };
  }

  if (!strategyRecord || !strategyRecord.code) {
    throw createServiceError('NOT_FOUND', 'Strategy not found or contains no code for ' + (lookupName || strategy_id || 'unnamed') + '.');
  }

  // 4. Acquire Concurrency Lock & Run Simulation
  tenantBacktestLocks.add(tenantId);

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(createServiceError('TIMEOUT', 'Backtest simulation timed out after 60s')), RUN_TIMEOUT_MS)
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
    const { summary, trades, equity_curve, trigger_candles = [] } = result;

    if (!trigger_candles || trigger_candles.length === 0) {
      throw createServiceError('EMPTY_DATA', 'No candle data for ' + normProduct + ' trigger_tf=' + trigger_tf);
    }

    // Cap stored candles to last 3000 points
    const storedCandles = trigger_candles.length > MAX_STORED_CANDLES
      ? trigger_candles.slice(-MAX_STORED_CANDLES)
      : trigger_candles;

    // 5. Persistence
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
        trades: trades.slice(-100),
        equity_curve: equity_curve.slice(-200),
        trigger_candles: storedCandles,
        effective_parameters: parameters,
        config: {
          parameters
        }
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
        console.warn('[BACKTEST SERVICE] backtest_results insert returned error:', insertError.message);
      }
    } catch (e) {
      console.warn('[BACKTEST SERVICE] backtest_results insert skipped:', e.message);
    }

    return {
      summary,
      trades,
      equity_curve,
      trigger_candles: storedCandles,
      effective_parameters: parameters,
      run_id: runId
    };
  } catch (err) {
    if (err.message && err.message.startsWith('no candle data')) {
      throw createServiceError('EMPTY_DATA', err.message);
    }
    throw err;
  } finally {
    tenantBacktestLocks.delete(tenantId);
  }
}
