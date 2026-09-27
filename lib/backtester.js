// lib/backtester.js
// ?? PUSH AM46  Strategy Backtester Engine (Sandboxed vm simulation with live parity)
// ?? PUSH AM46b  profit_factor + veto_cooldown_minutes parity

import vm from 'node:vm';
import * as technicalindicators from 'technicalindicators';
import { fetchCandles, resolveGranularity } from './candles.js';
import { contractSizeFor } from './asset-contract-size.js';
import { compileStrategy, execStrategy } from './strategy-executor.js';

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

  // Strategy default or param-level exit thresholds
  const defaultTpPct = Number(parameters.tp_percent) || 0.05;
  const defaultSlPct = Number(parameters.sl_percent) || 0.02;
  const tripwirePct = Number(parameters.tripwire_percent) || 0;
  const trailStepPct = Number(parameters.trail_step_percent) || 0;
  const trailActivationPct = Number(parameters.trail_activation_percent) || tripwirePct;
  const cooldownSec = (Number(parameters.veto_cooldown_minutes) || 0) * 60;

  // Closed-bar walk state
  const trades = [];
  const equityCurve = [];
  let currentEquity = 10000; // Starting baseline $10,000 for equity curve tracking
  equityCurve.push({ t: triggerCandles[0].time, equity: currentEquity });

  let activePosition = null;
  let lastExitEpoch = null;
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
      if (!activePosition.tripped && tripwirePct > 0 && roe >= tripwirePct) {
        activePosition.tripped = true;
        activePosition.sl_price = isLong ? entryPrice * 1.001 : entryPrice * 0.999;
      }

      // Trailing step ratchet (watchdog parity): ratchet stop along high/low
      if (trailStepPct > 0 && roe >= trailActivationPct) {
        activePosition.trailing = true;
        const stepDist = (trailStepPct / leverage) * currentBar.close;
        const candidateStop = isLong ? currentBar.close - stepDist : currentBar.close + stepDist;

        if (activePosition.sl_price == null) {
          activePosition.sl_price = candidateStop;
        } else if (isLong) {
          activePosition.sl_price = Math.max(activePosition.sl_price, candidateStop);
        } else {
          activePosition.sl_price = Math.min(activePosition.sl_price, candidateStop);
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
        // SL wins tie
        exitPrice = activePosition.sl_price;
        exitReason = activePosition.trailing ? 'TRAIL' : activePosition.tripped ? 'TRIPWIRE' : 'SL';
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
          bars_held: activePosition.bars_held
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

          // TP / SL levels from strategy decision or fallback parameters
          let tpPrice = Number(decision?.tpPrice);
          let slPrice = Number(decision?.slPrice);

          if (!tpPrice || isNaN(tpPrice)) {
            tpPrice = side === 'LONG' ? entryPrice * (1 + defaultTpPct) : entryPrice * (1 - defaultTpPct);
          }
          if (!slPrice || isNaN(slPrice)) {
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
            bars_held: 0,
            entry_bar_index: i
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

  const summary = {
    total_trades: totalTrades,
    win_rate: winRate,
    total_pnl_usd: parseFloat(totalPnlUsd.toFixed(2)),
    profit_factor: profitFactor,
    max_drawdown_usd: parseFloat(maxDrawdownUsd.toFixed(2)),
    expectancy_usd: expectancyUsd,
    avg_hold_bars: avgHoldBars
  };

  return {
    summary,
    trades,
    equity_curve: equityCurve,
    trigger_candles: triggerCandles
  };
}
