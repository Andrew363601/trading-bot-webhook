// lib/backtester.js
// ?? PUSH AM46  Strategy Backtester Engine (Sandboxed vm simulation with live parity)
// ?? PUSH AM46b  profit_factor + veto_cooldown_minutes parity

import vm from 'node:vm';
import * as technicalindicators from 'technicalindicators';
import { fetchCandles, resolveGranularity } from './candles.js';
import { contractSizeFor } from './asset-contract-size.js';
import { compileStrategy, execStrategy } from './strategy-executor.js';
import { classifyRegimeProxy, REGIME_PROXY_VERSION } from './regime-proxy.js';
import { validateRegimeParamsMap, resolveRegimeParams } from './regime-params.js';

/**
 * AM48: compile+execute shim extracted into lib/strategy-executor.js so the
 * live router and the backtester share the exact same sandboxed code path
 * (backtest <-> live parity). These wrappers keep the AM46 public API stable.
 */
export function sanitizeStrategyCodeForVm(code) {
  // Kept for backwards compatibility with existing imports/tests.
  if (typeof code !== 'string') return '';
  return code
    .replace(/^\s*import\s+[^;]+;?/gm, '// [import stripped for vm execution]')
    .replace(/^\s*export\s+(default\s+)?/gm, '');
}

export function compileStrategyInSandbox(code) {
  const compiled = compileStrategy(code);
  if (!compiled.ok) {
    throw new Error(compiled.errors.join(' | '));
  }
  return (macroCandles, triggerCandles, params) => {
    return compiled.runRef(macroCandles, triggerCandles, params);
  };
}

/**
 * Executes a backtest simulation.
 *
 * @param {Object} options
 * @param {string} options.code - Raw JS source code of the strategy
 * @param {Object} [options.parameters] - Strategy parameters overrides
 * @param {string} options.product - Symbol/Product ID (e.g. 'BTC-USD', 'DOGE-PERP-INTX')
 * @param {string|number} options.macro_tf - Macro timeframe (e.g. 'ONE_HOUR', 3600)
 * @param {string|number} options.trigger_tf - Trigger timeframe (e.g. 'FIVE_MINUTE', 300)
 * @param {number|string} options.start - Start time (epoch seconds or ISO string)
 * @param {number|string} options.end - End time (epoch seconds or ISO string)
 * @param {number} [options.fee_rate] - Taker fee rate (e.g. 0.0008)
 * @param {Array} [options.syntheticTriggerCandles] - Pre-supplied candles for dry-run/unit testing
 * @param {Array} [options.syntheticMacroCandles] - Pre-supplied candles for dry-run/unit testing
 * @returns {Promise<{ summary: Object, trades: Array, equity_curve: Array }>}
 */
export async function runBacktest({
  code,
  parameters = {},
  product = 'BTC-USD',
  macro_tf = 'ONE_HOUR',
  trigger_tf = 'FIVE_MINUTE',
  start,
  end,
  fee_rate,
  syntheticTriggerCandles = null,
  syntheticMacroCandles = null
}) {
  if (!code || typeof code !== 'string') {
    throw new Error('Strategy code is required for backtest execution.');
  }

  // Compile strategy runner inside VM sandbox
  const runStrategy = compileStrategyInSandbox(code);

  const startEpoch = typeof start === 'number' ? start : Math.floor(new Date(start).getTime() / 1000);
  const endEpoch = typeof end === 'number' ? end : Math.floor(new Date(end).getTime() / 1000);

  const { granularitySeconds: macroSec } = resolveGranularity(macro_tf);
  const { granularitySeconds: triggerSec } = resolveGranularity(trigger_tf);

  // 1. Fetch candles (or use synthetic if provided)
  let triggerCandles = [];
  let macroCandles = [];

  if (syntheticTriggerCandles && Array.isArray(syntheticTriggerCandles)) {
    triggerCandles = syntheticTriggerCandles;
    macroCandles = syntheticMacroCandles || syntheticTriggerCandles;
  } else {
    // Macro lookback buffer: fetch macro candles starting slightly earlier to allow indicator warmup (e.g. 100 bars)
    const macroWarmupEpoch = startEpoch - (macroSec * 100);

    const [tCandles, mCandles] = await Promise.all([
      fetchCandles({ product, granularitySeconds: triggerSec, startEpoch, endEpoch }),
      fetchCandles({ product, granularitySeconds: macroSec, startEpoch: macroWarmupEpoch, endEpoch })
    ]);

    triggerCandles = tCandles;
    macroCandles = mCandles;
  }

  // Loud-empty doctrine: zero candles fetched -> throw clear error
  if (!triggerCandles || triggerCandles.length === 0) {
    throw new Error(`no candle data for ${product} trigger_tf=${trigger_tf}`);
  }

  // Sizing and contract specs
  const multiplier = Number(parameters.contract_size || parameters.multiplier) || contractSizeFor(product);
  const leverage = Math.max(Number(parameters.leverage) || 1, 1);
  const targetUsd = Number(parameters.target_usd) || Number(parameters.notional_usd) || 1000;
  const configQty = Number(parameters.qty) || 0;
  const takerFeeRate = Number(fee_rate ?? parameters.agent_taker_fee_rate ?? 0.0008);

  // Strategy default or param-level exit thresholds (BASE geometry).
  const defaultTpPct = Number(parameters.tp_percent) || 0.05;
  const defaultSlPct = Number(parameters.sl_percent) || 0.02;
  const tripwirePct = Number(parameters.tripwire_percent) || 0;
  const trailStepPct = Number(parameters.trail_step_percent) || 0;
  const trailActivationPct = Number(parameters.trail_activation_percent) || tripwirePct;
  // AM52f — cooldown default parity with the sniper's TF-scaled default
  // (workers/sniper.js: min(max(3 x triggerTfMinutes, 5), 720) minutes).
  // NOTE: semantics differ — the backtester cooldown is exit->entry; the sniper
  // is veto->entry. Matching the default VALUE aligns spacing, not the anchor.
  const triggerTfMinutes = triggerSec / 60;
  const defaultCooldownMins = Math.min(Math.max(3 * triggerTfMinutes, 5), 720);
  const cooldownSec = (Number(parameters.veto_cooldown_minutes) || defaultCooldownMins) * 60;

  // AM53c — regime-conditional exit geometry. Validate the map LOUDLY up front
  // (never silently trade base on a malformed map). The validator throws a
  // plain { error } object; re-wrap as an Error so callers get a real throw.
  try {
    validateRegimeParamsMap(parameters.regime_params);
  } catch (e) {
    throw new Error(`invalid regime_params: ${e && e.error ? e.error : String(e)}`);
  }

  // Closed-bar walk state
  const trades = [];
  const equityCurve = [];
  let currentEquity = 10000; // Starting baseline $10,000 for equity curve tracking
  equityCurve.push({ t: triggerCandles[0].time, equity: currentEquity });

  let activePosition = null;
  let lastExitEpoch = null;
  // AM50 — lazy per-entry-bar regime cache. Entries are sparse, so we only
  // classify the regime at the bar where a trade actually opens (not every bar).
  const regimeCache = new Map(); // entry_bar_index -> regime label
  const regimeAtBar = (barIndex) => {
    if (regimeCache.has(barIndex)) return regimeCache.get(barIndex);
    const barTimeForRegime = triggerCandles[barIndex].time;
    const macroForRegime = macroCandles.filter((m) => m.time <= barTimeForRegime);
    const label = classifyRegimeProxy(macroForRegime);
    regimeCache.set(barIndex, label);
    return label;
  };
  // activePosition shape:
  // { side, entry_time, entry_price, qty, tp_price, sl_price, tripped, trailing, bars_held, entry_bar_index }

  // Warmup threshold: require at least 10 trigger bars before invoking strategy
  const warmupBars = Math.min(20, Math.floor(triggerCandles.length / 4));

  for (let i = 0; i < triggerCandles.length; i++) {
    const currentBar = triggerCandles[i];
    const barTime = currentBar.time;

    // A. Check exit if position is open
    if (activePosition) {
      activePosition.bars_held += 1;
      const isLong = activePosition.side === 'LONG';
      const entryPrice = activePosition.entry_price;

      // Update ROE for tripwire & trailing stop
      const rawMove = isLong
        ? (currentBar.close - entryPrice) / entryPrice
        : (entryPrice - currentBar.close) / entryPrice;
      const roe = rawMove * leverage;

      // Tripwire (watchdog parity): ROE >= tripwire_percent -> move SL to break-even (1.001 / 0.999)
      if (!activePosition.tripped && activePosition.tripwirePct > 0 && roe >= activePosition.tripwirePct) {
        activePosition.tripped = true;
        activePosition.sl_price = isLong ? entryPrice * 1.001 : entryPrice * 0.999;
        // AM58 4a — stop is now the break-even level (not the original SL).
        activePosition.stop_kind = 'be';
      }

      // Trailing step ratchet (watchdog parity): ratchet stop along high/low
      if (activePosition.trailStepPct > 0 && roe >= activePosition.trailActivationPct) {
        activePosition.trailing = true;
        const stepDist = (activePosition.trailStepPct / leverage) * currentBar.close;
        let candidateStop = isLong ? currentBar.close - stepDist : currentBar.close + stepDist;
        // AM58 4b — BE floor: a trail that can fire below entry is a stop, not a
        // trail. Behavior change ONLY for tripwire=0/sl=0 configs (the floor fires
        // immediately); no-op for tripwire+SL configs (BE is already set first).
        candidateStop = isLong ? Math.max(candidateStop, entryPrice * 1.001) : Math.min(candidateStop, entryPrice * 0.999);

        if (activePosition.sl_price == null) {
          activePosition.sl_price = candidateStop;
          activePosition.stop_kind = 'trail';
        } else if (isLong) {
          if (candidateStop > activePosition.sl_price) {
            activePosition.sl_price = candidateStop;
            activePosition.stop_kind = 'trail';
          }
        } else {
          if (candidateStop < activePosition.sl_price) {
            activePosition.sl_price = candidateStop;
            activePosition.stop_kind = 'trail';
          }
        }
      }

      // Check Intrabar SL / TP touch (conservative: SL wins same-bar ties)
      let hitSL = false;
      let hitTP = false;

      if (activePosition.sl_price != null) {
        hitSL = isLong ? currentBar.low <= activePosition.sl_price : currentBar.high >= activePosition.sl_price;
      }

      if (activePosition.tp_price != null) {
        hitTP = isLong ? currentBar.high >= activePosition.tp_price : currentBar.low <= activePosition.tp_price;
      }

      let exitPrice = null;
      let exitReason = null;

      if (hitSL) {
        // SL wins tie. AM58 4a — label by STOP LEVEL at hit time, not by the
        // trailing flag (which flips on the first bar roe >= activation even if
        // the ratchet never raised the stop). Original-SL exits below entry were
        // being recorded as TRAIL losses — a poisoned tuning signal.
        exitPrice = activePosition.sl_price;
        exitReason = activePosition.stop_kind === 'trail' ? 'TRAIL'
          : activePosition.stop_kind === 'be' ? 'TRIPWIRE'
          : 'SL';
      } else if (hitTP) {
        exitPrice = activePosition.tp_price;
        exitReason = 'TP';
      } else if (i === triggerCandles.length - 1) {
        // End of backtest data horizon -> close at market close
        exitPrice = currentBar.close;
        exitReason = 'HORIZON';
      }

      if (exitPrice != null) {
        const qty = activePosition.qty;
        // PnL calculation: points * qty * multiplier (matching trade_logs & watchdog)
        const pts = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
        const grossPnlUsd = pts * qty * multiplier;

        // Taker fees on both sides: notional * feeRate
        const entryNotional = entryPrice * qty * multiplier;
        const exitNotional = exitPrice * qty * multiplier;
        const totalFeesUsd = (entryNotional + exitNotional) * takerFeeRate;

        const netPnlUsd = grossPnlUsd - totalFeesUsd;
        currentEquity += netPnlUsd;

        trades.push({
          side: activePosition.side,
          entry_time: activePosition.entry_time,
          entry_price: parseFloat(entryPrice.toFixed(6)),
          exit_time: barTime,
          exit_price: parseFloat(exitPrice.toFixed(6)),
          exit_reason: exitReason,
          pnl_usd: parseFloat(netPnlUsd.toFixed(2)),
          bars_held: activePosition.bars_held,
          regime: activePosition.regime,
          exit_source: activePosition.exit_source
        });

        equityCurve.push({ t: barTime, equity: parseFloat(currentEquity.toFixed(2)) });
        lastExitEpoch = barTime;
        activePosition = null;
      }
    }

    // B. Check entry signal at bar close (canon: 1 position at a time, flat entry only)
    if (!activePosition && i >= warmupBars && i < triggerCandles.length - 1) {
      // Cooldown check (AM46b): require (barTime - lastExitEpoch) >= veto_cooldown_minutes * 60
      const isCooledDown = lastExitEpoch == null || (barTime - lastExitEpoch) >= cooldownSec;

      if (isCooledDown) {
        // Feed macro candles up to current trigger time and trigger candles up to bar i
        const macroSlice = macroCandles.filter(m => m.time <= barTime);
        const triggerSlice = triggerCandles.slice(0, i + 1);

        let decision = null;
        try {
          decision = await execStrategy(runStrategy, macroSlice, triggerSlice, parameters, 2000);
        } catch (err) {
          // Catch runtime errors from user code to prevent crashing backtest run
          console.warn(`[BACKTEST] Strategy threw error at bar ${i} (${barTime}):`, err.message);
        }

        const rawSignal = decision?.signal ? String(decision.signal).toUpperCase().trim() : null;

        if (rawSignal === 'LONG' || rawSignal === 'SHORT' || rawSignal === 'BUY' || rawSignal === 'SELL') {
          const side = (rawSignal === 'LONG' || rawSignal === 'BUY') ? 'LONG' : 'SHORT';
          const entryPrice = currentBar.close;

          // Position sizing: qty from config or computed from targetUsd / (entryPrice * multiplier)
          let qty = configQty;
          if (!qty || qty <= 0) {
            qty = targetUsd / (entryPrice * multiplier);
          }

          // TP / SL levels from strategy decision or fallback parameters.
          // AM53c — when the regime map supplies tp_percent/sl_percent, the MAP
          // governs geometry and OVERRIDES the strategy's explicit prices
          // (user decision; diverges from live AM53 which only hard-binds
          // mechanical paths). Otherwise strategy prices win, base pct fallback.
          const regime = regimeAtBar(i);
          const resolved = resolveRegimeParams(parameters, regime);
          const ov = resolved.overrides_applied || {};
          const exitSource = Object.keys(ov).length > 0 ? 'map' : 'base';
          const posTpPct = Number(resolved.params.tp_percent) || defaultTpPct;
          const posSlPct = Number(resolved.params.sl_percent) || defaultSlPct;
          const posTripwirePct = Number(resolved.params.tripwire_percent) || tripwirePct;
          const posTrailStepPct = Number(resolved.params.trail_step_percent) || trailStepPct;
          // trail_activation_percent is NOT a per-regime key (global by design).
          const posTrailActivationPct = Number(resolved.params.trail_activation_percent) || posTripwirePct;

          let tpPrice = Number(decision?.tpPrice);
          let slPrice = Number(decision?.slPrice);

          if (ov.tp_percent != null) {
            tpPrice = side === 'LONG' ? entryPrice * (1 + posTpPct) : entryPrice * (1 - posTpPct);
          } else if (!tpPrice || isNaN(tpPrice)) {
            tpPrice = side === 'LONG' ? entryPrice * (1 + defaultTpPct) : entryPrice * (1 - defaultTpPct);
          }
          if (ov.sl_percent != null) {
            slPrice = side === 'LONG' ? entryPrice * (1 - posSlPct) : entryPrice * (1 + posSlPct);
          } else if (!slPrice || isNaN(slPrice)) {
            slPrice = side === 'LONG' ? entryPrice * (1 - defaultSlPct) : entryPrice * (1 + defaultSlPct);
          }

          activePosition = {
            side,
            entry_time: barTime,
            entry_price: entryPrice,
            qty,
            tp_price: tpPrice,
            sl_price: slPrice,
            tripped: false,
            trailing: false,
            // AM58 4a — stop provenance: 'original' | 'be' | 'trail'. Drives the
            // exit_reason label at hit time (level-based, not flag-based).
            stop_kind: 'original',
            bars_held: 0,
            entry_bar_index: i,
            // AM50 — regime at the ENTRY decision bar (lazy cached).
            regime,
            // AM53c — exit geometry resolved ONCE at open and locked on the
            // position (mirrors AM53 entry-lock). Never re-read mid-trade.
            tripwirePct: posTripwirePct,
            trailStepPct: posTrailStepPct,
            trailActivationPct: posTrailActivationPct,
            exit_source: exitSource
          };
        }
      }
    }
  }

  // Compute performance summary
  const totalTrades = trades.length;
  let winTrades = 0;
  let totalPnlUsd = 0;
  let totalBarsHeld = 0;
  let grossWinUsd = 0;
  let grossLossUsd = 0;

  let peakEquity = 10000;
  let maxDrawdownUsd = 0;

  for (const t of trades) {
    if (t.pnl_usd > 0) {
      winTrades++;
      grossWinUsd += t.pnl_usd;
    } else if (t.pnl_usd < 0) {
      grossLossUsd += Math.abs(t.pnl_usd);
    }
    totalPnlUsd += t.pnl_usd;
    totalBarsHeld += t.bars_held;
  }

  // Drawdown calculation from equity curve
  let runningPeak = 10000;
  for (const pt of equityCurve) {
    if (pt.equity > runningPeak) runningPeak = pt.equity;
    const dd = runningPeak - pt.equity;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
  }

  const winRate = totalTrades > 0 ? parseFloat((winTrades / totalTrades).toFixed(4)) : 0;
  const expectancyUsd = totalTrades > 0 ? parseFloat((totalPnlUsd / totalTrades).toFixed(2)) : 0;
  const avgHoldBars = totalTrades > 0 ? parseFloat((totalBarsHeld / totalTrades).toFixed(1)) : 0;
  const profitFactor = grossLossUsd > 0 ? parseFloat((grossWinUsd / grossLossUsd).toFixed(2)) : null;

  // AM50 — per-regime breakdown. Always emit all four buckets (zero-n buckets
  // render loud-dimmed in the Studio, never hidden). win_rate is null when n=0
  // so the UI never has to guard against 0/0.
  const regimeBuckets = { TREND: { n: 0, wins: 0, pnl: 0 }, CHOP: { n: 0, wins: 0, pnl: 0 }, ACCUMULATION: { n: 0, wins: 0, pnl: 0 }, DISTRIBUTION: { n: 0, wins: 0, pnl: 0 } };
  for (const t of trades) {
    const b = regimeBuckets[t.regime];
    if (!b) continue;
    b.n += 1;
    if (t.pnl_usd > 0) b.wins += 1;
    b.pnl += t.pnl_usd;
  }
  const regime_breakdown = {};
  for (const [regime, b] of Object.entries(regimeBuckets)) {
    regime_breakdown[regime] = {
      n: b.n,
      win_rate: b.n > 0 ? parseFloat((b.wins / b.n).toFixed(4)) : null,
      pnl_usd: parseFloat(b.pnl.toFixed(2))
    };
  }

  // AM53c — echo the resolved exit geometry per mapped regime so the tuning
  // loop can see exactly what the map produced (source 'map' vs 'base').
  const regime_exits_applied = {};
  if (parameters.regime_params && typeof parameters.regime_params === 'object') {
    for (const regime of Object.keys(parameters.regime_params)) {
      const r = resolveRegimeParams(parameters, regime);
      const applied = Object.keys(r.overrides_applied || {}).length > 0;
      regime_exits_applied[regime] = {
        tp_percent: Number(r.params.tp_percent) || defaultTpPct,
        sl_percent: Number(r.params.sl_percent) || defaultSlPct,
        tripwire_percent: Number(r.params.tripwire_percent) || tripwirePct,
        trail_step_percent: Number(r.params.trail_step_percent) || trailStepPct,
        source: applied ? 'map' : 'base'
      };
    }
  }

  const summary = {
    total_trades: totalTrades,
    win_rate: winRate,
    total_pnl_usd: parseFloat(totalPnlUsd.toFixed(2)),
    profit_factor: profitFactor,
    max_drawdown_usd: parseFloat(maxDrawdownUsd.toFixed(2)),
    expectancy_usd: expectancyUsd,
    avg_hold_bars: avgHoldBars,
    regime_breakdown,
    regime_exits_applied,
    regime_proxy_version: REGIME_PROXY_VERSION
  };

  return {
    summary,
    trades,
    equity_curve: equityCurve,
    trigger_candles: triggerCandles
  };
}
