// lib/microstructure-detector.js
// NEXUS L5 — Microstructure change detection + archetype classification.
//
// Two responsibilities:
//   1. getMicrostructureChange(asset, currentSnapshot) — compares the current
//      snapshot against the recent scan_results window (ALL tenants — market
//      data, Phase 0.9.5) to detect CVD divergence, absorption, volatility state,
//      and cross-asset coherence.
//   2. classifyArchetype(asset, snapshot, regime, microChange) — rule-based
//      decision tree over the 12 archetypes, enriched with stats from the
//      microstructure_archetypes table (global rows, per-tenant overlay when
//      ≥20 samples exist).

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────
// 1. MICROSTRUCTURE CHANGE DETECTION
// ─────────────────────────────────────────────────────────────────

export async function getMicrostructureChange(asset, currentSnapshot) {
    const cacheKey = `mc:${asset}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

    try {
        // Recent scans (2h window) across all tenants — market data, deduped by minute
        const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const { data: scans, error } = await supabase
            .from('scan_results')
            .select('telemetry, created_at')
            .eq('asset', asset)
            .gte('created_at', since)
            .order('created_at', { ascending: true })
            .limit(500);
        if (error) throw new Error(error.message);

        const seen = new Set();
        const series = [];
        for (const s of scans || []) {
            const t = typeof s.telemetry === 'string' ? JSON.parse(s.telemetry) : (s.telemetry || {});
            const d = new Date(s.created_at);
            d.setSeconds(0, 0);
            if (seen.has(d.getTime())) continue;
            seen.add(d.getTime());
            series.push({
                time: d.getTime(),
                cvd: parseFloat(t.cvd) || 0,
                macro_cvd: parseFloat(t.macro_cvd) || parseFloat(t.cvd) || 0,
                price: parseFloat(t.price) || null,
                bids: parseFloat(t.bids) || 0,
                asks: parseFloat(t.asks) || 0
            });
        }

        const s = currentSnapshot?.result || currentSnapshot || {};
        const price = s.current_price ?? s.price ?? null;
        const microCvd = s.multi_timeframe_cvd?.['5M_Micro_Ripple'] ?? s.cvd ?? 0;
        const macroCvd = s.multi_timeframe_cvd?.['6H_Macro_Tide'] ?? s.macro_cvd ?? 0;
        const atrNow = s.volatility_atr?.['5M'] ?? s.atr ?? null;

        const result = {
            available: series.length >= 5,
            divergence: detectDivergence(series, price, macroCvd),
            absorption: detectAbsorption(series, s),
            volatility: detectVolatility(series, atrNow, s),
            coherence: detectCoherence(s),
            windowScans: series.length
        };

        CACHE.set(cacheKey, { data: result, ts: Date.now() });
        return result;
    } catch (e) {
        console.error('[MICRO-DETECT] failed (non-fatal):', e.message);
        return { available: false };
    }
}

/** CVD divergence: price makes new extremes while macro CVD moves opposite. */
function detectDivergence(series, price, macroCvd) {
    const withPrice = series.filter(p => p.price);
    if (withPrice.length < 6 || !price) {
        return { detected: false, type: 'convergence', strength: 0, description: 'Insufficient price history in window' };
    }
    const firstHalf = withPrice.slice(0, Math.floor(withPrice.length / 2));
    const secondHalf = withPrice.slice(Math.floor(withPrice.length / 2));
    const avg = arr => arr.reduce((a, b) => a + b.price, 0) / arr.length;

    const priceDelta = avg(secondHalf) - avg(firstHalf);
    const cvdFirst = firstHalf.reduce((a, b) => a + b.macro_cvd, 0) / firstHalf.length;
    const cvdSecond = secondHalf.reduce((a, b) => a + b.macro_cvd, 0) / secondHalf.length;
    const cvdDelta = cvdSecond - cvdFirst;

    const normPrice = Math.abs(priceDelta) / Math.max(price, 0.01) * 10000;  // bps
    const normCvd = Math.abs(cvdDelta) / (Math.max(Math.abs(cvdFirst), 1));
    let strength = Math.round(Math.min(normPrice * normCvd * 2, 100));

    if (priceDelta > 0 && cvdDelta < 0 && strength >= 20) {
        return { detected: true, type: 'bearish_divergence', strength, description: 'Price making higher highs while CVD fades — rally lacks volume backing' };
    }
    if (priceDelta < 0 && cvdDelta > 0 && strength >= 20) {
        return { detected: true, type: 'bullish_divergence', strength, description: 'Price making lower lows while CVD improves — accumulation into weakness' };
    }
    return { detected: false, type: 'convergence', strength, description: 'Price and CVD direction aligned' };
}

/** Order book absorption: bid/ask ratio trend + wall sweep proxy. */
function detectAbsorption(series, snapshot) {
    if (series.length < 4) {
        return { rate: 'steady', wallSweepsLast5m: 0, netWallDirection: 'neutral', description: 'Insufficient book history' };
    }
    const ratios = series.filter(p => p.asks > 0).map(p => p.bids / p.asks);
    if (ratios.length < 4) {
        return { rate: 'steady', wallSweepsLast5m: 0, netWallDirection: 'neutral', description: 'Insufficient depth history' };
    }
    const firstR = ratios.slice(0, Math.ceil(ratios.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(ratios.length / 2);
    const lastR = ratios.slice(Math.ceil(ratios.length / 2)).reduce((a, b) => a + b, 0) / (ratios.length - Math.ceil(ratios.length / 2));
    const change = (lastR - firstR) / Math.max(firstR, 0.01);

    let rate = 'steady', description = 'Order book balance stable';
    if (change > 0.15) { rate = 'accelerating'; description = 'Bid side thickening fast — passive buyers stacking'; }
    else if (change < -0.15) { rate = 'accelerating'; description = 'Ask side thickening fast — passive sellers stacking'; }
    else if (change > 0.05) { rate = 'steady'; description = 'Bids gradually building — mild support'; }
    else if (change < -0.05) { rate = 'steady'; description = 'Asks gradually building — mild pressure'; }
    else { rate = 'decelerating'; description = 'Book imbalance decaying — range likely to persist'; }

    const netWallDirection = lastR > 1.15 ? 'bid' : lastR < 0.87 ? 'ask' : 'neutral';
    return { rate, wallSweepsLast5m: 0, netWallDirection, description, bidAskChangePercent: Math.round(change * 100) };
}

/** Volatility state: ATR trend from the snapshot's 5M value + Bollinger-style width proxy. */
function detectVolatility(series, atrNow, snapshot) {
    const atrTrigger = snapshot?.volatility_atr?.Trigger || null;
    let atrChangePercent = null;
    let atrTrend = 'flat';
    // ATR trend inferred from price-range compression in the scan window
    const withPrice = series.filter(p => p.price);
    if (withPrice.length >= 6) {
        const ranges = [];
        for (let i = 1; i < withPrice.length; i++) {
            ranges.push(Math.abs(withPrice[i].price - withPrice[i - 1].price));
        }
        const firstHalf = ranges.slice(0, Math.ceil(ranges.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(ranges.length / 2);
        const secondHalf = ranges.slice(Math.ceil(ranges.length / 2)).reduce((a, b) => a + b, 0) / (ranges.length - Math.ceil(ranges.length / 2));
        if (firstHalf > 0) {
            atrChangePercent = Math.round((secondHalf - firstHalf) / firstHalf * 1000) / 10;
            atrTrend = atrChangePercent < -5 ? 'falling' : atrChangePercent > 5 ? 'rising' : 'flat';
        }
    }
    const state = atrTrend === 'falling' ? 'compressing' : atrTrend === 'rising' ? 'expanding' : 'neutral';
    return {
        state,
        atrTrend,
        atrChangePercent,
        bbWidthPercent: null,   // requires candle data — trainer computes this
        description: `Micro range ${state} (tick-range ${atrTrend} ${atrChangePercent !== null ? atrChangePercent + '%' : ''})${atrTrigger ? `; trigger ATR: ${atrTrigger}` : ''}`
    };
}

/** Cross-asset coherence: does the asset's regime match BTC/ETH context? */
function detectCoherence(snapshot) {
    const s = snapshot?.result || snapshot || {};
    const assetRegime = s.regime || s.macro_regime_oracle || null;
    const cross = s.cross_asset_regimes || null;
    if (!cross) {
        return { btcRegime: null, ethRegime: null, assetRegime, correlation: null };
    }
    return {
        btcRegime: cross.BTC || null,
        ethRegime: cross.ETH || null,
        assetRegime,
        correlation: cross.correlation ?? null
    };
}

// ─────────────────────────────────────────────────────────────────
// 2. ARCHETYPE CLASSIFICATION (12 archetypes)
// ─────────────────────────────────────────────────────────────────

const ARCHETYPE_STATS_MIN_TENANT = 20;

/**
 * Rule-based decision tree over regime + microstructure change output.
 * Falls back to Euclidean distance from learned centroids only when >50
 * labeled trades exist per archetype (trainer populates those); for now the
 * decision tree is the classifier — deterministic and debuggable.
 */
export function classifyArchetypeRule(regime, micro) {
    const div = micro?.divergence || {};
    const vol = micro?.volatility || {};
    const abs = micro?.absorption || {};
    const coh = micro?.coherence || {};
    const divType = div.type || 'convergence';
    const volState = vol.state || 'neutral';

    // 12-archetype decision tree (ordered — first match wins)
    if (regime === 'TREND') {
        if (divType === 'bearish_divergence' && div.strength >= 35) return 'trend_continuation_weak_cvd';
        if (divType === 'convergence' || divType === 'bullish_divergence') return 'trend_continuation_strong_cvd';
        return 'trend_continuation_weak_cvd';
    }
    if (regime === 'CHOP') {
        if (volState === 'compressing' && abs.netWallDirection !== 'neutral') return 'chop_breakout_preparation';
        if (volState === 'expanding') return 'breakout_volume_expansion';
        return 'chop_range_bounce_poc';
    }
    if (regime === 'ACCUMULATION') {
        if (divType === 'bullish_divergence') return 'accumulation_dip_cvd_divergence';
        if (abs.rate === 'accelerating' && abs.netWallDirection === 'bid') return 'accumulation_dip_cvd_divergence';
        return 'liquidity_sweep_reversal';
    }
    if (regime === 'DISTRIBUTION') {
        if (divType === 'bearish_divergence') return 'distribution_rally_cvd_failure';
        return 'hawk_trap_counter_trend';
    }
    // Cross-asset drag: BTC/ETH trending but asset chop
    if (coh.btcRegime === 'TREND' && (coh.assetRegime === 'CHOP' || !coh.assetRegime)) {
        return 'cross_asset_drag_divergence';
    }
    // Funding extremes handled at the caller when derivatives_premium is available
    return 'chop_range_bounce_poc';
}

/**
 * MAIN ENTRY — classify + attach stats (tenant overlay when available).
 */
export async function classifyArchetype(tenantId, asset, snapshot, regime, microChange) {
    try {
        const archetype = classifyArchetypeRule(regime, microChange);

        // Stats: global structural row first, tenant overlay when ≥20 samples
        const { data: rows } = await supabase
            .from('microstructure_archetypes')
            .select('tenant_id, sample_count, win_rate, avg_pnl, avg_tp_atr, avg_sl_atr, avg_hold_time_minutes, optimal_tripwire_percent, optimal_trail_step_percent')
            .eq('asset', asset)
            .eq('archetype_name', archetype)
            .order('sample_count', { ascending: false })
            .limit(2);

        const globalRow = (rows || []).find(r => r.tenant_id === null && r.sample_count >= 30);
        const ownRow = tenantId ? (rows || []).find(r => r.tenant_id === tenantId && r.sample_count >= ARCHETYPE_STATS_MIN_TENANT) : null;
        const statsRow = ownRow || globalRow || null;

        let archetypeStats = null;
        if (statsRow) {
            archetypeStats = {
                sampleCount: statsRow.sample_count,
                winRate: statsRow.win_rate,
                avgPnl: statsRow.avg_pnl,
                optimalTpAtr: statsRow.avg_tp_atr,
                optimalSlAtr: statsRow.avg_sl_atr,
                optimalTripwirePercent: statsRow.optimal_tripwire_percent,
                optimalTrailStepPercent: statsRow.optimal_trail_step_percent,
                avgHoldTimeMinutes: statsRow.avg_hold_time_minutes
            };
        }

        return {
            archetype,
            confidence: microChange?.available ? Math.min(60 + (microChange.windowScans || 0), 95) : 50,
            archetypeStats,
            scope: ownRow ? 'tenant' : (globalRow ? 'global' : 'none')
        };
    } catch (e) {
        console.error('[ARCHETYPE] classification failed (non-fatal):', e.message);
        return { archetype: null, confidence: 0, archetypeStats: null, scope: 'none' };
    }
}
