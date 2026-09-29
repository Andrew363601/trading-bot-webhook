// lib/backtest-service.js
// PUSH AM47 - Strategy Studio Backtest Orchestration Service

import { runBacktest } from './backtester.js';
import { resolveGranularity, normalizeProduct } from './candles.js';
// 🟢 PUSH AM54 — shared tool-arg integrity (string-parameters normalization).
import { normalizeParametersArg } from './tool-arg-integrity.js';

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
  product, // PUSH AM49d — NO silent fallback. Missing product must fail LOUD.
  macro_tf = 'ONE_HOUR',
  trigger_tf = 'FIVE_MINUTE',
  start,
  end,
  fee_rate
}) {
  if (!tenantId) {
    throw createServiceError('UNAUTHORIZED', 'No tenant context provided.');
  }

  // 🟢 PUSH AM54 — defense-in-depth: non-chat callers may also pass `parameters`
  // as a JSON string (the manual OpenRouter loop does not enforce zod). A truthy
  // string would pass `parameters || {}` and silently replicate defaults. Parse
  // it here, or fail LOUD — never trade on a silently-ignored override set.
  const paramNorm = normalizeParametersArg(parameters);
  if (!paramNorm.ok) {
    throw createServiceError('BAD_REQUEST', paramNorm.error);
  }
  parameters = paramNorm.parameters;

  // PUSH AM49d — product integrity: a falsy/non-string product previously
  // defaulted to BTC-USD, silently running the backtest on BTC while reporting
  // the requested symbol (fabricated provenance). Fail loudly instead.
  if (!product || typeof product !== 'string') {
    throw createServiceError('BAD_REQUEST', 'product is required (e.g. ETP-20DEC30-CDE, BTC-PERP-INTX, ETH-USD). No silent fallback is permitted.');
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
    // AM50 — single execution timestamp shared by the persisted payload and the
    // API response, so the Studio can compare "latest persisted" vs "local run"
    // and auto-sync without clobbering a fresh manual run.
    const executedAt = new Date().toISOString();

    // A. Update strategy_library.latest_backtest if associated with an existing library item
    if (strategyRecord.id) {
      const latestBacktestPayload = {
        executed_at: executedAt,
        product: normProduct,
        macro_tf,
        trigger_tf,
        start_epoch: startEpoch,
        end_epoch: endEpoch,
        summary,
        // AM50 — persist the full trade log (was slice(-100)) so the Studio trade
        // table reconciles with summary.regime_breakdown.n.
        trades: trades.slice(-2000),
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

    // C. PUSH AM52a — Studio Episode Theater per-run persistence.
    // backtest_results holds summary columns only; the theater needs the rich
    // per-run shapes (trades w/ regime, equity, candles, params, breakdown).
    // Insert failure must NOT fail the run: catch + console.warn.
    try {
      const pnlPercent = parseFloat(((summary.total_pnl_usd / 10000) * 100).toFixed(2));
      const horizonLabel = tfToHorizon(trigger_tf);

      await supabase
        .from('studio_runs')
        .insert({
          tenant_id: tenantId,
          run_id: runId,
          product: normProduct,
          horizon: horizonLabel,
          first_close: storedCandles?.length ? Number(storedCandles[0].close ?? storedCandles[0].c ?? null) : null,
          run_window: { start: startEpoch, end: endEpoch, days: parseFloat(rangeDays.toFixed(2)) },
          parameters,
          effective_parameters: parameters,
          summary: {
            total_trades: summary.total_trades,
            win_rate: summary.win_rate,
            pnl_usd: summary.total_pnl_usd,
            pnl_percent: pnlPercent,
            profit_factor: summary.profit_factor,
            max_drawdown: summary.max_drawdown_usd,
            // AM53c — echo the resolved per-regime exit geometry so the tuning
            // loop can see what the map produced (source 'map' vs 'base').
            regime_exits_applied: summary.regime_exits_applied || {}
          },
          regime_breakdown: summary.regime_breakdown || null,
          regime_proxy_version: summary.regime_proxy_version || null,
          trades: trades.slice(-2000),
          equity_curve: equity_curve.slice(-500),
          trigger_candles: storedCandles
        });
    } catch (e) {
      console.warn('[BACKTEST SERVICE] studio_runs insert skipped:', e.message);
    }

    // D. PUSH AM51 — strategy_param_priors bank. One row per regime from the
    // run's regime_breakdown + effective_parameters. Context-only for tuning
    // proposals; never a veto authority. Catch+warn — never fails the run.
    // NOTE: builder has no .catch (AM52h) -> use try/catch.
    try {
      if (strategyRecord.id && summary.regime_breakdown) {
        const proxyVersion = summary.regime_proxy_version || null;
        const rows = [];
        for (const [regime, b] of Object.entries(summary.regime_breakdown)) {
          // Skip zero-n buckets: win_rate is null and expectancy is 0/0.
          if (!b || !b.n || b.n <= 0) continue;
          const wr = b.win_rate == null ? null : b.win_rate;
          const pnlUsd = Number(b.pnl_usd) || 0;
          rows.push({
            tenant_id: tenantId,
            library_id: strategyRecord.id,
            regime,
            params: parameters || {},
            metrics: {
              wr,
              pnl: pnlUsd,
              expectancy: parseFloat((pnlUsd / b.n).toFixed(4)),
              profit_factor: summary.profit_factor ?? null
            },
            n: b.n,
            source: 'backtest',
            regime_proxy_version: proxyVersion,
            updated_at: executedAt
          });
        }
        if (rows.length) {
          const { error: priorsError } = await supabase
            .from('strategy_param_priors')
            .upsert(rows, { onConflict: 'tenant_id,library_id,regime,regime_proxy_version,source' });
          if (priorsError) console.warn('[BACKTEST SERVICE] priors upsert skipped:', priorsError.message);
        }
      }
    } catch (e) {
      console.warn('[BACKTEST SERVICE] priors upsert skipped:', e.message);
    }

    return {
      summary,
      trades,
      equity_curve,
      trigger_candles: storedCandles,
      effective_parameters: parameters,
      run_id: runId,
      executed_at: executedAt,
      // PUSH AM49d — provenance echo: product actually simulated + first
      // trigger-candle close so callers can self-verify price scale.
      product: normProduct,
      first_close: storedCandles?.length ? Number(storedCandles[0].close ?? storedCandles[0].c ?? null) : null
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
