// lib/predictive-regression.js
// NEXUS L3 — Win-probability predictions from trained calibration_models.
//
// Tiered resolution (Phase 0.9.3):
//   Tier 1: (tenant, asset, regime, strategy, tf_pair)
//   Tier 2: (global tenant_id NULL, same keys)
//   Tier 3: widen — drop strategy → drop tf_pair (both scopes at each step)
//   Tier 4: { available: false } → prompt omits the block entirely
//
// strategy is UPPER-normalized at every read (case-split buckets fragment).

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

const CACHE = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MIN_SAMPLES = 50;

function norm(v) {
    return v ? String(v).toUpperCase() : 'ANY';
}

async function fetchModelRow(tenantId, asset, regime, strategy, tfPair) {
    let q = supabase
        .from('calibration_models')
        .select('asset, regime, strategy, sample_count, expected_pnl_mean, expected_pnl_std, feature_importance, metrics, last_trained, model_params')
        .eq('asset', asset)
        .eq('regime', regime)
        .eq('strategy', strategy)
        .limit(1);
    if (tenantId === null) {
        q = q.is('tenant_id', null);
    } else {
        q = q.eq('tenant_id', tenantId);
    }
    if (tfPair) q = q.eq('model_params->>tf_pair', tfPair);
    const { data, error } = await q;
    if (error) return null;
    return (data && data.length > 0) ? data[0] : null;
}

/**
 * MAIN ENTRY — resolve the best model for this asset+regime+strategy+tf_pair.
 * @returns {Promise<{available: boolean, winProbability?, expectedPnl?, ...}>}
 */
export async function getModelPrediction(tenantId, asset, regime, strategyId = null, tfPair = null, currentSnapshot = null) {
    const cacheKey = `${tenantId || 'G'}:${asset}:${regime || 'ANY'}:${norm(strategyId)}:${norm(tfPair)}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

    const regimeKey = regime || 'CHOP';
    const strategy = norm(strategyId);
    const tf = norm(tfPair);

    try {
        // Tier 1 → 2 exact; Tier 3a → 3b widened (drop strategy), then drop tf_pair
        const attempts = [
            { tenant: tenantId, strategy, tf },
            { tenant: null, strategy, tf },
            { tenant: tenantId, strategy: 'ANY', tf },
            { tenant: null, strategy: 'ANY', tf },
            { tenant: tenantId, strategy: 'ANY', tf: null },
            { tenant: null, strategy: 'ANY', tf: null }
        ];

        let row = null;
        for (const a of attempts) {
            row = await fetchModelRow(a.tenant, asset, regimeKey, a.strategy, a.tf);
            if (row && row.sample_count >= MIN_SAMPLES) {
                row._scope = a.tenant === null ? 'global' : 'tenant';
                row._tier = attempts.indexOf(a) + 1;
                break;
            }
            row = null;
        }

        let result;
        if (!row) {
            result = { available: false };
        } else {
            const metrics = row.metrics || {};
            // Model params may carry logistic weights for a lightweight in-JS
            // inference path; if absent, fall back to the model's empirical WR.
            const params = row.model_params || {};
            let winProbability = null;
            if (params.weights && currentSnapshot) {
                try {
                    let z = params.intercept || 0;
                    for (const [feat, w] of Object.entries(params.weights)) {
                        const cur = resolveFeatureValue(currentSnapshot, feat);
                        if (cur !== null) z += w * cur;
                    }
                    winProbability = 1 / (1 + Math.exp(-z));
                } catch (e) { winProbability = null; }
            }
            if (winProbability === null) {
                winProbability = metrics.win_rate ?? 0.5;
            }

            const fi = row.feature_importance || {};
            const topFeatures = Object.entries(fi)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, importance]) => ({
                    name,
                    importance,
                    currentValue: currentSnapshot ? resolveFeatureValue(currentSnapshot, name) : null
                }));

            const std = row.expected_pnl_std || 0;
            const mean = row.expected_pnl_mean || 0;

            result = {
                available: true,
                winProbability,
                expectedPnl: mean,
                confidenceInterval: [
                    Math.round(mean - 1.96 * std),
                    Math.round(mean + 1.96 * std)
                ],
                topFeatures,
                sampleCount: row.sample_count,
                modelAccuracy: metrics.accuracy ?? null,
                scope: row._scope,
                tier: row._tier,
                lastTrained: row.last_trained
            };
        }

        CACHE.set(cacheKey, { data: result, ts: Date.now() });
        return result;
    } catch (e) {
        console.error('[PRED-REG] model lookup failed (non-fatal):', e.message);
        return { available: false };
    }
}

/**
 * Resolve a named feature's current value from the live market snapshot.
 * Mirrors the trainer's feature extraction (Phase 4) so current values are
 * comparable to training-time distributions.
 */
export function resolveFeatureValue(snapshot, featureName) {
    if (!snapshot) return null;
    const s = snapshot.result || snapshot;
    try {
        switch (featureName) {
            case 'cvd_6h_macro_tide': return s.multi_timeframe_cvd?.['6H_Macro_Tide'] ?? s.macro_cvd ?? null;
            case 'cvd_1h_macro_trend': return s.multi_timeframe_cvd?.['1H_Macro_Trend'] ?? null;
            case 'cvd_5m_micro_ripple': return s.multi_timeframe_cvd?.['5M_Micro_Ripple'] ?? s.cvd ?? null;
            case 'trigger_flow': return s.multi_timeframe_cvd?.['Trigger_Flow'] ?? null;
            case 'orderbook_imbalance': {
                const b = s.order_book_depth?.deep_bids ?? s.bids ?? null;
                const a = s.order_book_depth?.deep_asks ?? s.asks ?? null;
                return (b !== null && a) ? b / Math.max(a, 0.01) : null;
            }
            case 'funding_rate': return s.derivatives_premium?.funding_rate ?? null;
            case 'funding_annualized': return s.derivatives_premium?.annualized_funding_percent ?? null;
            case 'open_interest': return s.derivatives_premium?.open_interest ?? null;
            case 'atr_5m': return s.volatility_atr?.['5M'] ?? s.atr ?? null;
            case 'price_dist_from_poc_atr': {
                const price = s.current_price ?? s.price;
                const poc = s.volume_profile?.macro_poc ?? s.macro_poc;
                const atr = s.volatility_atr?.['5M'] ?? s.atr;
                return (price && poc && atr) ? Math.abs(price - poc) / Math.max(atr, 0.01) : null;
            }
            case 'price_to_upper_node': {
                const price = s.current_price ?? s.price;
                const node = s.volume_profile?.upper_node ?? s.upper_node;
                const atr = s.volatility_atr?.['5M'] ?? s.atr;
                return (price && node && atr) ? Math.abs(node - price) / Math.max(atr, 0.01) : null;
            }
            case 'price_to_lower_node': {
                const price = s.current_price ?? s.price;
                const node = s.volume_profile?.lower_node ?? s.lower_node;
                const atr = s.volatility_atr?.['5M'] ?? s.atr;
                return (price && node && atr) ? Math.abs(price - node) / Math.max(atr, 0.01) : null;
            }
            case 'sp500': { const v = s.cross_asset_macro?.SP500; return v ? v / 1000 : null; }
            case 'dxy': return s.cross_asset_macro?.DXY ?? null;
            default: return null;
        }
    } catch (e) { return null; }
}
