// lib/calibration-engine.js
// NEXUS L1/L2 — Empirical win-rate priors + conviction calibration.
//
// Resolution order (Phase 0.9.3): tenant's own trades first; when a bucket has
// < minSamples, falls back to global (all-tenant) stats. Prompt builder labels
// the provenance ("Your WR..." vs "(all users) WR...").
//
// All stats come from closed trades (exit_price IS NOT NULL). Only numeric
// aggregates cross the tenant boundary — no lessons, no theses, no PII.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

const VALID_REGIMES = ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'];
const CONVICTION_BUCKETS = [[0, 20], [21, 40], [41, 60], [61, 80], [81, 100]];

// In-process cache — priors move slowly (recomputed per closed trade), so a
// 10-minute TTL avoids hammering trade_logs on every sniper wake.
const CACHE = new Map(); // key -> { data, ts }
const CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeRegime(r) {
    return VALID_REGIMES.includes(r) ? r : null;
}

/**
 * Aggregate closed trades into per-regime WR / avg PnL / per-asset WR.
 * @param {string|null} tenantId null = all tenants (global stats)
 */
async function computeStats(tenantId, asset) {
    let query = supabase
        .from('trade_logs')
        .select('symbol, regime_at_entry, pnl, exit_price')
        .not('exit_price', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (asset) query = query.eq('symbol', asset);

    const { data: trades, error } = await query;
    if (error) { console.error('[CALIB-ENGINE] trade fetch failed:', error.message); return null; }
    if (!trades || trades.length === 0) return null;

    const regimeAgg = {};   // regime -> { wins, n, pnlSum }
    const assetAgg = {};    // asset  -> { wins, n }
    let totalWins = 0, totalN = 0, pnlSum = 0;

    for (const t of trades) {
        const pnl = parseFloat(t.pnl) || 0;
        const win = pnl >= 0 ? 1 : 0;
        const sym = t.symbol || asset || 'UNKNOWN';
        const regime = normalizeRegime(t.regime_at_entry) || 'CHOP';

        if (!regimeAgg[regime]) regimeAgg[regime] = { wins: 0, n: 0, pnlSum: 0 };
        regimeAgg[regime].wins += win; regimeAgg[regime].n += 1; regimeAgg[regime].pnlSum += pnl;

        if (!assetAgg[sym]) assetAgg[sym] = { wins: 0, n: 0 };
        assetAgg[sym].wins += win; assetAgg[sym].n += 1;

        totalWins += win; totalN += 1; pnlSum += pnl;
    }

    const regimeWR = {}, regimeAvgPnl = {}, regimeSamples = {};
    for (const [regime, a] of Object.entries(regimeAgg)) {
        regimeWR[regime] = a.wins / a.n;
        regimeAvgPnl[regime] = a.pnlSum / a.n;
        regimeSamples[regime] = a.n;
    }
    const assetWR = {};
    for (const [sym, a] of Object.entries(assetAgg)) {
        if (a.n >= 5) assetWR[sym] = a.wins / a.n;
    }

    return {
        overallWR: totalN > 0 ? totalWins / totalN : null,
        overallAvgPnl: totalN > 0 ? pnlSum / totalN : null,
        sampleCount: totalN,
        regimeWR, regimeAvgPnl, regimeSamples, assetWR
    };
}

/**
 * L2 — Conviction calibration: compare stated conviction_score (bucketed)
 * against actual WR per regime. Positive bias = overconfident.
 * Requires agent_tool_calls joined to trade outcomes by trade_id.
 */
async function computeConvictionCalibration(tenantId, regime) {
    let query = supabase
        .from('agent_tool_calls')
        .select('conviction_score, trade_id, created_at')
        .eq('tool_name', 'execute_order')
        .not('conviction_score', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500);
    if (tenantId) query = query.eq('tenant_id', tenantId);

    const { data: calls, error } = await query;
    if (error || !calls || calls.length < 15) return null;  // min 15 calls to calibrate

    const tradeIds = calls.map(c => c.trade_id).filter(Boolean);
    if (tradeIds.length === 0) return null;

    const { data: trades } = await supabase
        .from('trade_logs')
        .select('id, pnl, regime_at_entry')
        .in('id', tradeIds)
        .not('exit_price', 'is', null);
    if (!trades || trades.length === 0) return null;

    const outcomeById = new Map(trades.map(t => [t.id, t]));
    const bucketStats = {};  // bucketLabel -> { wins, n }
    const regimeBias = {};   // regime -> { statedSum, actualWRSum, n }

    for (const c of calls) {
        const t = outcomeById.get(c.trade_id);
        if (!t) continue;
        const pnl = parseFloat(t.pnl) || 0;
        const win = pnl >= 0 ? 1 : 0;
        const score = parseInt(c.conviction_score, 10);
        if (isNaN(score)) continue;

        const bucket = CONVICTION_BUCKETS.find(([lo, hi]) => score >= lo && score <= hi);
        if (bucket) {
            const label = `${bucket[0]}-${bucket[1]}`;
            if (!bucketStats[label]) bucketStats[label] = { wins: 0, n: 0 };
            bucketStats[label].wins += win; bucketStats[label].n += 1;
        }

        const reg = normalizeRegime(t.regime_at_entry) || 'CHOP';
        if (!regimeBias[reg]) regimeBias[reg] = { statedSum: 0, actualWRSum: 0, n: 0 };
        regimeBias[reg].statedSum += score;
        regimeBias[reg].actualWRSum += win * 100;
        regimeBias[reg].n += 1;
    }

    // Calibration curve: stated conviction vs actual WR per bucket
    const calibration = {};
    for (const [label, s] of Object.entries(bucketStats)) {
        if (s.n >= 5) calibration[label] = { statedMid: parseInt(label.split('-')[0], 10) + 10, actualWR: s.wins / s.n, n: s.n };
    }

    // Per-regime bias: avg stated conviction − avg actual WR (in points)
    const bias = {};
    for (const [reg, b] of Object.entries(regimeBias)) {
        if (b.n >= 10) bias[reg] = Math.round((b.statedSum / b.n) - (b.actualWRSum / b.n));
    }

    // Calibrated minimum conviction for the requested regime: if the agent runs
    // hot in this regime, raise the bar by the bias; if cold, lower slightly.
    let calibratedMinConviction = null;
    if (regime && bias[regime] !== undefined) {
        calibratedMinConviction = Math.min(Math.max(50 + Math.round(bias[regime] * 0.5), 40), 85);
    }

    return { calibration, bias, calibratedMinConviction, sampleCount: Object.values(regimeBias).reduce((a, b) => a + b.n, 0) };
}

/**
 * MAIN ENTRY — Empirical priors for one asset+regime, tenant→global fallback.
 * Returns { own, global } so the prompt builder labels provenance correctly.
 */
export async function getCalibrationPriors(tenantId, asset, regime, strategyId = null) {
    const cacheKey = `${tenantId || 'GLOBAL'}:${asset}:${regime || 'ANY'}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

    try {
        const [ownStats, globalStats, ownConv, globalConv] = await Promise.all([
            computeStats(tenantId, asset),
            computeStats(null, asset),
            computeConvictionCalibration(tenantId, regime),
            computeConvictionCalibration(null, regime)
        ]);

        const minOwn = 20, minGlobal = 30;

        const own = ownStats && ownStats.sampleCount >= minOwn ? {
            regimeWR: ownStats.regimeWR,
            regimeAvgPnl: ownStats.regimeAvgPnl,
            assetWR: ownStats.assetWR,
            overallWR: ownStats.overallWR,
            sampleCount: ownStats.sampleCount,
            convictionBias: ownConv?.bias || null,
            calibratedMinConviction: ownConv?.calibratedMinConviction || null,
            convictionSampleCount: ownConv?.sampleCount || 0
        } : null;

        const global = globalStats && globalStats.sampleCount >= minGlobal ? {
            regimeWR: globalStats.regimeWR,
            regimeAvgPnl: globalStats.regimeAvgPnl,
            assetWR: globalStats.assetWR,
            overallWR: globalStats.overallWR,
            sampleCount: globalStats.sampleCount,
            convictionBias: (!ownConv || (ownConv.sampleCount || 0) < 15) ? (globalConv?.bias || null) : null,
            calibratedMinConviction: (!ownConv || (ownConv.sampleCount || 0) < 15) ? (globalConv?.calibratedMinConviction || null) : null
        } : null;

        const result = { available: !!(own || global), own, global };
        CACHE.set(cacheKey, { data: result, ts: Date.now() });
        return result;
    } catch (e) {
        console.error('[CALIB-ENGINE] priors failed (non-fatal):', e.message);
        return { available: false, own: null, global: null };
    }
}

/**
 * Convenience for the sniper — returns the flat best-available view with
 * provenance tags, matching the prompt-builder expectations.
 */
export function resolvePriorsForPrompt(priors, regime, asset) {
    if (!priors || !priors.available) return null;
    const pick = (ownVal, globalVal) => {
        if (ownVal !== undefined && ownVal !== null) return { value: ownVal, scope: 'tenant' };
        if (globalVal !== undefined && globalVal !== null) return { value: globalVal, scope: 'global' };
        return null;
    };
    const own = priors.own, g = priors.global;
    return {
        available: true,
        regimeWR: pick(own?.regimeWR?.[regime], g?.regimeWR?.[regime]),
        regimeAvgPnl: pick(own?.regimeAvgPnl?.[regime], g?.regimeAvgPnl?.[regime]),
        assetWR: pick(own?.assetWR?.[asset], g?.assetWR?.[asset]),
        overallWR: pick(own?.overallWR, g?.overallWR),
        sampleCount: pick(own?.sampleCount, g?.sampleCount),
        convictionBias: pick(own?.convictionBias?.[regime], g?.convictionBias?.[regime]),
        calibratedMinConviction: pick(own?.calibratedMinConviction, g?.calibratedMinConviction)
    };
}
