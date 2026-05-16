// lib/risk-validator.js
// Validates AI-generated trade parameters against the tenant's risk profile.
// Clamps SL/qty if the trade exceeds the user's risk budget.

import { createClient } from '@supabase/supabase-js';

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
 * Get asset multiplier for risk calculation (contract size).
 */
function getAssetMultiplier(symbol) {
  if (!symbol) return 1.0;
  const s = symbol.toUpperCase();
  if (s.includes('ETP') || s.includes('ETH')) return 0.1;
  if (s.includes('BIT') || s.includes('BIP') || s.includes('BTC')) return 0.01;
  if (s.includes('SLP') || s.includes('SOL')) return 5.0;
  if (s.includes('DOP') || s.includes('DOGE')) return 1000.0;
  if (s.includes('LCP') || s.includes('LTC')) return 1.0;
  if (s.includes('AVP') || s.includes('AVAX')) return 1.0;
  if (s.includes('LNP') || s.includes('LINK')) return 1.0;
  return 1.0;
}

/**
 * Validates a trade against the tenant's risk profile.
 * 
 * @param {string} tenantId - The tenant UUID
 * @param {Object} tradeParams - { side, symbol, entryPrice, slPrice, tpPrice, qty, leverage }
 * @returns {Object} { approved: boolean, clamped_sl: number|null, clamped_qty: number|null, reason: string }
 */
export async function validateTradeRisk(tenantId, tradeParams) {
  const { side, symbol, entryPrice, slPrice, tpPrice, qty, leverage } = tradeParams;

  if (!tenantId) {
    return { approved: false, clamped_sl: null, clamped_qty: null, reason: 'No tenant ID provided — trade blocked by risk validator.' };
  }

  const settings = await getRiskSettings(tenantId);

  // If no risk settings configured, skip validation
  if (!settings.risk_per_trade_percent && !settings.max_position_size_usd && !settings.max_leverage) {
    return { approved: true, clamped_sl: null, clamped_qty: null, reason: 'No risk profile configured — skipping validation.' };
  }

  const multiplier = getAssetMultiplier(symbol);
  let clampedSl = slPrice;
  let clampedQty = qty;
  let warnings = [];

  // --- CHECK 1: Max Leverage ---
  if (settings.max_leverage && leverage && leverage > settings.max_leverage) {
    warnings.push(`Leverage ${leverage}x exceeds max ${settings.max_leverage}x`);
    // We don't clamp leverage here — the strategy config controls it
  }

  // --- CHECK 2: Max Position Size ---
  if (settings.max_position_size_usd && entryPrice && qty) {
    const positionValue = entryPrice * qty * multiplier;
    if (positionValue > settings.max_position_size_usd) {
      const maxQty = Math.floor(settings.max_position_size_usd / (entryPrice * multiplier));
      clampedQty = Math.max(1, maxQty);
      warnings.push(`Position $${positionValue.toFixed(2)} exceeds max $${settings.max_position_size_usd}. Qty clamped to ${clampedQty}.`);
    }
  }

  // --- CHECK 3: Risk Per Trade ---
  if (settings.risk_per_trade_percent && settings.account_balance_usd && entryPrice && slPrice && qty) {
    const maxRiskAmount = settings.account_balance_usd * (settings.risk_per_trade_percent / 100);
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
        if (side === 'BUY' && clampedSl >= tpPrice) {
          // SL would be past TP — reduce qty instead
          const safeQty = Math.floor(maxRiskAmount / (priceDistance * multiplier));
          clampedQty = Math.max(1, safeQty);
          clampedSl = slPrice; // restore original SL
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. Qty reduced to ${clampedQty}.`);
        } else if (side === 'SELL' && clampedSl <= tpPrice) {
          const safeQty = Math.floor(maxRiskAmount / (priceDistance * multiplier));
          clampedQty = Math.max(1, safeQty);
          clampedSl = slPrice;
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. Qty reduced to ${clampedQty}.`);
        } else {
          warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. SL clamped to $${clampedSl.toFixed(2)}.`);
        }
      } else {
        warnings.push(`Risk $${riskAmount.toFixed(2)} exceeds max $${maxRiskAmount.toFixed(2)}. SL clamped to $${clampedSl.toFixed(2)}.`);
      }
    }
  }

  // --- CHECK 4: Daily Profit Target (used as a soft ceiling for daily loss) ---
  // Uses daily_roi_target_usd as a proxy for acceptable daily risk exposure.
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
        // If we've lost more than half the daily target in realized losses, flag it
        if (todayRealized < 0 && Math.abs(todayRealized) >= dailyTarget * 0.5) {
          // Warning but don't block — just log
          console.warn(`[RISK VALIDATOR] Daily loss ($${Math.abs(todayRealized).toFixed(2)}) is >= 50% of daily target ($${dailyTarget}).`);
        }
      }
    } catch (e) {
      console.warn('[RISK VALIDATOR] Daily check failed:', e.message);
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

  const approved = warnings.length === 0;
  const hasClamps = (clampedSl !== slPrice) || (clampedQty !== qty);

  if (hasClamps) {
    console.log(`[RISK VALIDATOR] Trade clamped for ${tenantId}:`, warnings.join('; '));
  }

  return {
    approved: true,
    clamped_sl: clampedSl !== slPrice ? clampedSl : null,
    clamped_qty: clampedQty !== qty ? clampedQty : null,
    reason: approved
      ? (hasClamps ? `Risk validation passed with adjustments: ${warnings.join('; ')}` : 'Risk validation passed.')
      : warnings.join('; ')
  };
}
