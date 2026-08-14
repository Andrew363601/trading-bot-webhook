// lib/risk-validator.js
// Validates AI-generated trade parameters against the tenant's risk profile.
// Clamps SL/qty if the trade exceeds the user's risk budget.
// Policy is differential: PAPER mode is permissive (warn + clamp), LIVE is strict (block).

import { createClient } from '@supabase/supabase-js';
import { getRealBalance } from './asset-resolver.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Fetches the tenant's risk settings from tenant_settings.
 */
async function getRiskSettings(tenantId) {
  const { data, error } = await supabase
    .from('tenant_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    console.warn(`[RISK VALIDATOR] No risk settings for tenant ${tenantId}, using defaults.`);
    return {
      account_balance_usd: null,
      max_position_size_usd: null,
      max_leverage: null,
      risk_per_trade_percent: null,
      daily_roi_target_usd: null,
      max_concurrent_trades: null,
      allowed_assets: null
    };
  }

  return data;
}

/**
 * Validates a trade against the tenant's risk profile.
 *
 * @param {string} tenantId - The tenant UUID
 * @param {Object} tradeParams - { side, symbol, entryPrice, slPrice, tpPrice, qty, leverage }
 * @param {Object} [options={}] - { assetSpecs, executionMode }
 * @param {Object} [options.assetSpecs] - Contract specs from AssetResolver
 * @param {'PAPER'|'LIVE'} [options.executionMode='PAPER'] - Execution mode for policy
 * @returns {Promise<Object>} { approved, clamped_sl, clamped_qty, reason }
 */
export async function validateTradeRisk(tenantId, tradeParams, options = {}) {
  const { side, symbol, entryPrice, slPrice, tpPrice, qty, leverage } = tradeParams;
  const { assetSpecs = null, executionMode = 'PAPER' } = options;

  if (!tenantId) {
    return { approved: false, clamped_sl: null, clamped_qty: null, reason: 'No tenant ID provided — trade blocked by risk validator.' };
  }

  const settings = await getRiskSettings(tenantId);

  // --- CHECK 0: Risk profile required ---
  // LIVE must have a configured risk profile. PAPER is allowed without one
  // (but warns the user to configure one before going live).
  const hasRiskProfile = settings.risk_per_trade_percent || settings.max_position_size_usd || settings.max_leverage;
  if (!hasRiskProfile) {
    if (executionMode === 'LIVE') {
      return {
        approved: false,
        clamped_sl: null,
        clamped_qty: null,
        reason: 'Risk profile required for LIVE trading. Complete risk assessment in Settings first.'
      };
    }
    // PAPER: allow with warning
    return {
      approved: true,
      clamped_sl: null,
      clamped_qty: null,
      reason: 'No risk profile configured — PAPER mode allowed. Set risk limits in Settings for LIVE.'
    };
  }

  // Use contract_size from asset specs (dynamic, Coinbase-sourced) instead of
  // the old hardcoded getAssetMultiplier().
  const multiplier = assetSpecs?.contract_size || 1.0;
  if (!assetSpecs?.contract_size) {
    console.warn(`[RISK VALIDATOR] No contract_size in assetSpecs for ${symbol}. Using fallback multiplier 1.0.`);
  }

  let clampedSl = slPrice;
  let clampedQty = qty;
  let warnings = [];
  let blocked = false;
  let blockReason = null;

  // --- CHECK 1: Max Leverage ---
  if (settings.max_leverage && leverage && leverage > settings.max_leverage) {
    const msg = `Leverage ${leverage}x exceeds max ${settings.max_leverage}x`;
    if (executionMode === 'LIVE') {
      return {
        approved: false,
        clamped_sl: null,
        clamped_qty: null,
        reason: `${msg} for LIVE trading.`
      };
    }
    warnings.push(`${msg} — PAPER only.`);
  }

  // --- CHECK 2: Max Position Size ---
  if (settings.max_position_size_usd && entryPrice && qty) {
    const positionValue = entryPrice * qty * multiplier;
    if (positionValue > settings.max_position_size_usd) {
      const maxQty = Math.floor(settings.max_position_size_usd / (entryPrice * multiplier));
      if (maxQty < 1) {
        return {
          approved: false,
          clamped_sl: null,
          clamped_qty: null,
          reason: `Position size exceeds max by too much. Minimum position is 1 contract but max allows 0 (entry=$${entryPrice}, multiplier=${multiplier}, max=${settings.max_position_size_usd}).`
        };
      }
      clampedQty = maxQty;
      warnings.push(`Position $${positionValue.toFixed(2)} exceeds max $${settings.max_position_size_usd}. Qty clamped to ${clampedQty}.`);
    }
  }

  // --- CHECK 3: Risk Per Trade ---
  // Resolve effective balance: use real-time CFM balance if available,
  // fall back to static tenant_settings. If neither is available, LIVE blocks.
  let effectiveBalance = settings.account_balance_usd ? parseFloat(settings.account_balance_usd) : null;
  try {
    const realBalance = await getRealBalance(tenantId, 'coinbase');
    if (realBalance.balance_usd != null && !realBalance.error) {
      // Use the smaller of real balance and configured balance as a safety cap.
      // If configured balance is lower, the user may have set a manual cap;
      // if real balance is lower, the account has dropped since configuration.
      effectiveBalance = effectiveBalance != null
        ? Math.min(realBalance.balance_usd, effectiveBalance)
        : realBalance.balance_usd;
      console.log(`[RISK VALIDATOR] Effective balance: $${effectiveBalance.toFixed(2)} (real=$${realBalance.balance_usd}, configured=$${settings.account_balance_usd || 'N/A'})`);
    }
  } catch (e) {
    console.warn(`[RISK VALIDATOR] Real balance fetch failed: ${e.message}. Using configured balance.`);
  }

  if (settings.risk_per_trade_percent && effectiveBalance != null && entryPrice && slPrice && qty) {
    const maxRiskAmount = effectiveBalance * (settings.risk_per_trade_percent / 100);
    const priceDistance = Math.abs(entryPrice - slPrice);
    const riskAmount = priceDistance * qty * multiplier;

    if (riskAmount > maxRiskAmount) {
      // Try clamping SL first (move it closer)
      const maxSlDistance = maxRiskAmount / (qty * multiplier);
      if (side === 'BUY' || side === 'LONG') {
        clampedSl = entryPrice - maxSlDistance;
      } else {
        clampedSl = entryPrice + maxSlDistance;
      }

      // Check if clamped SL still makes sense (not past TP)
      if (tpPrice) {
        if ((side === 'BUY' || side === 'LONG') && clampedSl >= tpPrice) {
          // SL would be past TP — reduce qty instead
          const safeQty = Math.floor(maxRiskAmount / (priceDistance * multiplier));
          if (safeQty < 1) {
            return {
              approved: false,
              clamped_sl: null,
              clamped_qty: null,
              reason: `Risk per trade exceeds budget. Minimum position is 1 contract but risk budget allows 0 (maxRisk=$${maxRiskAmount.toFixed(2)}, priceDist=$${priceDistance.toFixed(2)}, multiplier=${multiplier}).`
            };
          }
          clampedQty = safeQty;
          clampedSl = slPrice; // restore original SL
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. Qty reduced to ${clampedQty}.`);
        } else if ((side === 'SELL' || side === 'SHORT') && clampedSl <= tpPrice) {
          const safeQty = Math.floor(maxRiskAmount / (priceDistance * multiplier));
          if (safeQty < 1) {
            return {
              approved: false,
              clamped_sl: null,
              clamped_qty: null,
              reason: `Risk per trade exceeds budget. Minimum position is 1 contract but risk budget allows 0 (maxRisk=$${maxRiskAmount.toFixed(2)}, priceDist=$${priceDistance.toFixed(2)}, multiplier=${multiplier}).`
            };
          }
          clampedQty = safeQty;
          clampedSl = slPrice;
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. Qty reduced to ${clampedQty}.`);
        } else {
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. SL clamped to $${clampedSl.toFixed(2)}.`);
        }
      } else {
        warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. SL clamped to $${clampedSl.toFixed(2)}.`);
      }
    }
  } else if (settings.risk_per_trade_percent && effectiveBalance == null) {
    // No balance available — LIVE blocks, PAPER warns
    if (executionMode === 'LIVE') {
      return {
        approved: false,
        clamped_sl: null,
        clamped_qty: null,
        reason: 'Cannot verify account balance for LIVE trading. Configure your balance in Settings or ensure Coinbase API keys are set.'
      };
    }
    warnings.push('No account balance configured — risk-per-trade check skipped.');
  }

  // --- CHECK 4: Daily Loss Limit ---
  // Hard block at ≥100% of daily target (both modes). Warn at ≥50%.
  if (settings.daily_roi_target_usd) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: todayTrades } = await supabase
        .from('trade_logs')
        .select('pnl')
        .eq('tenant_id', tenantId)
        .gte('exit_time', today)
        .not('pnl', 'is', null);

      if (todayTrades) {
        const todayRealized = todayTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
        const dailyTarget = settings.daily_roi_target_usd;
        if (todayRealized < 0 && Math.abs(todayRealized) >= dailyTarget) {
          return {
            approved: false,
            clamped_sl: null,
            clamped_qty: null,
            reason: `Daily loss limit ($${dailyTarget}) reached. No more trades today. Realized: $${todayRealized.toFixed(2)}.`
          };
        }
        if (todayRealized < 0 && Math.abs(todayRealized) >= dailyTarget * 0.5) {
          warnings.push(`Daily loss at $${Math.abs(todayRealized).toFixed(2)} (${Math.round(Math.abs(todayRealized) / dailyTarget * 100)}% of target). Proceed with caution.`);
        }
      }
    } catch (e) {
      console.warn('[RISK VALIDATOR] Daily loss check failed:', e.message);
    }
  }

  // --- CHECK 5: Max Concurrent Trades ---
  if (settings.max_concurrent_trades) {
    try {
      const { data: openTrades } = await supabase
        .from('trade_logs')
        .select('id')
        .eq('tenant_id', tenantId)
        .is('exit_price', null);

      if (openTrades && openTrades.length >= settings.max_concurrent_trades) {
        return {
          approved: false,
          clamped_sl: null,
          clamped_qty: null,
          reason: `Max concurrent trades (${settings.max_concurrent_trades}) reached. Close an existing position first.`
        };
      }
    } catch (e) {
      console.warn('[RISK VALIDATOR] Concurrent trades check failed:', e.message);
    }
  }

  const hasClamps = (clampedSl !== slPrice) || (clampedQty !== qty);

  if (hasClamps) {
    console.log(`[RISK VALIDATOR] Trade clamped for ${tenantId} (${executionMode}):`, warnings.join('; '));
  }

  return {
    approved: true,
    clamped_sl: clampedSl !== slPrice ? clampedSl : null,
    clamped_qty: clampedQty !== qty ? clampedQty : null,
    reason: blocked
      ? blockReason
      : (hasClamps ? `Risk validation passed with adjustments: ${warnings.join('; ')}` : 'Risk validation passed.')
  };
}
