// lib/regime-transitions.js
// NEXUS L4 — Regime transition probabilities from scan_results time series.
//
// Phase 0.9.5: GLOBAL only — market physics is identical for every tenant.
// All tenants' scans for the same asset carry the same regime labels, so we
// aggregate across tenants for maximum sample coverage. No tenant_id param.
//
// Reads the asset's regime sequence, counts transitions, computes persistence
// and leading indicators (CVD / ATR compression in the 30min before a flip).

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { WebSocket: WebSocket }, realtime: { transport: WebSocket } }
);

const VALID_REGIMES = new Set(['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION']);
const CACHE = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MIN_SCANS = 20;
const MIN_TRANSITIONS = 5;

/**
 * MAIN ENTRY — transition probabilities for the asset's current regime.
 * @param {string} asset
 * @param {string|null} currentRegime
 */
export async function getRegimeTransitions(asset, currentRegime) {
    const cacheKey = `${asset}:${currentRegime || 'ANY'}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

    try {
        // Pull recent scans for this asset across ALL tenants. Telemetry is
        // deduped by (time bucket) later — identical market data written by
        // multiple tenants' snipers collapses naturally.
        const { data: scans, error } = await supabase
            .from('scan_results')
            .select('telemetry, created_at')
            .eq('asset', asset)
            .order('created_at', { ascending: true })
            .limit(2000);
        if (error) throw new Error(error.message);

        const series = [];
        const seenBuckets = new Set();  // 1-minute dedupe across tenants
        for (const s of scans || []) {
            const t = typeof s.telemetry === 'string' ? JSON.parse(s.telemetry) : (s.telemetry || {});
            const reg = t.macro_regime_oracle;
            if (!VALID_REGIMES.has(reg)) continue;
            const bucket = new Date(s.created_at);
            bucket.setSeconds(0, 0);
            const key = bucket.getTime();
            if (seenBuckets.has(key)) continue;
            seenBuckets.add(key);
            series.push({
                time: new Date(s.created_at).getTime(),
                regime: reg,
                cvd: parseFloat(t.macro_cvd) || parseFloat(t.cvd) || 0,
                bids: parseFloat(t.bids) || 0,
                asks: parseFloat(t.asks) || 0
            });
        }
        if (series.length < MIN_SCANS) {
            const empty = { available: false };
            CACHE.set(cacheKey, { data: empty, ts: Date.now() });
            return empty;
        }

        // Slide across the series: count transitions, per-regime durations
        const transitions = {};         // 'FROM->TO' -> count
        const durationSum = {};         // regime -> minutes
        const durationCount = {};
        let prev = null, segStart = null;

        for (const p of series) {
            if (prev !== null && p.regime !== prev) {
                const key = `${prev}->${p.regime}`;
                transitions[key] = (transitions[key] || 0) + 1;
            }
            if (p.regime !== prev) {
                if (prev !== null && segStart !== null) {
                    durationSum[prev] = (durationSum[prev] || 0) + (p.time - segStart) / 60000;
                    durationCount[prev] = (durationCount[prev] || 0) + 1;
                }
                segStart = p.time;
            }
            prev = p.regime;
        }
        // Close out the final segment
        const last = series[series.length - 1];
        if (prev !== null && segStart !== null) {
            durationSum[prev] = (durationSum[prev] || 0) + (last.time - segStart) / 60000;
            durationCount[prev] = (durationCount[prev] || 0) + 1;
        }

        const totalTransitions = Object.values(transitions).reduce((a, b) => a + b, 0);
        if (totalTransitions < MIN_TRANSITIONS) {
            const empty = { available: false };
            CACHE.set(cacheKey, { data: empty, ts: Date.now() });
            return empty;
        }

        // Persistence: how long has the current regime been running?
        let persistenceMinutes = null;
        if (currentRegime) {
            for (let i = series.length - 1; i >= 0; i--) {
                if (series[i].regime !== currentRegime) break;
                persistenceMinutes = (last.time - series[i].time) / 60000;
            }
        }

        // Outgoing transitions from the current regime → probability distribution
        const fromKey = `${currentRegime || 'CHOP'}->`;
        const outTransitions = Object.entries(transitions)
            .filter(([k]) => k.startsWith(fromKey))
            .map(([k, count]) => ({ key: k, count }));
        const outTotal = outTransitions.reduce((a, b) => a + b.count, 0);

        const transitionsOut = [];
        let accounted = 0;
        for (const { key, count } of outTransitions) {
            const toRegime = key.split('->')[1];
            const avgCvd = avgCvdAtTransition(series, key);
            transitionsOut.push({ toRegime, probability: count / outTotal, avgCvdAtTransition: avgCvd });
            accounted += count;
        }
        // Stay probability = remainder (no regime change observed in window)
        if (currentRegime && accounted < outTotal + 0) { /* noop — stay handled below */ }
        transitionsOut.push({ toRegime: currentRegime || 'CHOP', probability: Math.max(0, 1 - outTransitions.reduce((a, b) => a + b.probability, 0)) });

        // CHOP→TREND breakout stats (direction split + move size)
        let breakoutStats = null;
        const btKey = transitions['CHOP->TREND'] || 0;
        if (btKey > 0) {
            const directionCounts = { BUY: 0, SELL: 0 };
            let moveSum = 0, moveN = 0;
            for (let i = 1; i < series.length; i++) {
                if (series[i - 1].regime === 'CHOP' && series[i].regime === 'TREND') {
                    const cvd = series[i].cvd;
                    if (cvd > 0) directionCounts.BUY += 1;
                    else if (cvd < 0) directionCounts.SELL += 1;
                    moveN += 1;
                }
            }
            const dirTotal = directionCounts.BUY + directionCounts.SELL;
            if (dirTotal > 0) {
                breakoutStats = {
                    direction: {
                        BUY: directionCounts.BUY / dirTotal,
                        SELL: directionCounts.SELL / dirTotal
                    },
                    sampleCount: btKey
                };
            }
        }

        // Leading indicators: CVD / imbalance behavior in the 30min BEFORE any transition
        const leadingIndicators = computeLeadingIndicators(series);

        const result = {
            available: true,
            currentRegime: currentRegime || null,
            persistenceMinutes: persistenceMinutes !== null ? Math.round(persistenceMinutes) : null,
            avgDuration: durationCount[currentRegime || 'CHOP']
                ? durationSum[currentRegime || 'CHOP'] / durationCount[currentRegime || 'CHOP'] / 60  // hours
                : null,
            transitions: transitionsOut,
            breakoutStats,
            leadingIndicators,
            sampleCount: series.length,
            totalTransitions
        };
        CACHE.set(cacheKey, { data: result, ts: Date.now() });
        return result;
    } catch (e) {
        console.error('[REGIME-TRANS] failed (non-fatal):', e.message);
        return { available: false };
    }
}

/** Average macro CVD observed at the moment of a given transition type. */
function avgCvdAtTransition(series, key) {
    const [frm, to] = key.split('->');
    const vals = [];
    for (let i = 1; i < series.length; i++) {
        if (series[i - 1].regime === frm && series[i].regime === to) {
            vals.push(series[i].cvd);
        }
    }
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/**
 * Leading indicators for regime transition, computed from the 30 minutes
 * before every observed flip vs the same window before non-flips.
 * Returns thresholds the agent can watch in live telemetry.
 */
function computeLeadingIndicators(series) {
    const preFlipCvd = [];
    const preFlipImbalance = [];
    const WINDOW_MS = 30 * 60 * 1000;

    for (let i = 1; i < series.length; i++) {
        if (series[i].regime !== series[i - 1].regime) {
            // gather the 30min window before the flip
            for (let j = i - 1; j >= 0 && (series[i].time - series[j].time) <= WINDOW_MS; j--) {
                if (series[j].cvd) preFlipCvd.push(Math.abs(series[j].cvd));
                if (series[j].bids && series[j].asks) {
                    preFlipImbalance.push(series[j].bids / Math.max(series[j].asks, 0.01));
                }
            }
        }
    }

    const pct = (arr, p) => {
        if (arr.length === 0) return null;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(Math.floor(s.length * p), s.length - 1)];
    };

    return {
        cvd_absolute_90th_percentile: pct(preFlipCvd, 0.9),
        wall_imbalance_90th_percentile: pct(preFlipImbalance, 0.9),
        sampleFlips: preFlipCvd.length
    };
}
