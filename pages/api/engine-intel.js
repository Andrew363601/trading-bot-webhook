// pages/api/engine-intel.js
// Authed endpoint for tenant's Engine Intelligence panel.
// Calculates model calibration buckets, priors, and engine health metrics.

import { verifyTenantContext } from '../../lib/auth-middleware';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let tenantContext;
  try {
    tenantContext = await verifyTenantContext(req);
  } catch (err) {
    return res.status(401).json({ error: err.message || 'Unauthorized' });
  }

  const { tenantId, supabase } = tenantContext;

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Parallel fetch:
    // 1. Tenant trade_logs with model_predicted_win_prob & exit_price
    // 2. Tenant calibration_models
    // 3. 7d shadow_portfolio records
    // 4. Tenant archetype records (microstructure_archetypes)
    const [tradesRes, calibrationRes, shadowRes, archetypesRes] = await Promise.all([
      supabase
        .from('trade_logs')
        .select('model_predicted_win_prob, exit_price, pnl, symbol')
        .eq('tenant_id', tenantId)
        .not('exit_price', 'is', null)
        .not('model_predicted_win_prob', 'is', null),
      supabase
        .from('calibration_models')
        .select('asset, regime, strategy, sample_count, expected_pnl_mean, metrics, last_trained')
        .eq('tenant_id', tenantId)
        .order('last_trained', { ascending: false }),
      supabase
        .from('shadow_portfolio')
        .select('verdict')
        .eq('tenant_id', tenantId)
        .gte('created_at', sevenDaysAgo),
      supabase
        .from('microstructure_archetypes')
        .select('id, asset, archetype_name, sample_count')
        .eq('tenant_id', tenantId)
    ]);

    const trades = tradesRes.data || [];
    const calibrationRows = calibrationRes.data || [];
    const shadowRows = shadowRes.data || [];
    const archetypes = archetypesRes.data || [];

    // ── 1. Model Calibration Buckets & Brier Score ──
    // Buckets: [0, 0.4), [0.4, 0.6), [0.6, 0.8), [0.8, 1.0]
    const buckets = [
      { range: '[0, 0.4)', min: 0, max: 0.4, n: 0, wins: 0, realizedWR: 0 },
      { range: '[0.4, 0.6)', min: 0.4, max: 0.6, n: 0, wins: 0, realizedWR: 0 },
      { range: '[0.6, 0.8)', min: 0.6, max: 0.8, n: 0, wins: 0, realizedWR: 0 },
      { range: '[0.8, 1.0]', min: 0.8, max: 1.0001, n: 0, wins: 0, realizedWR: 0 }
    ];

    let brierSum = 0;
    let brierCount = 0;

    trades.forEach(t => {
      const prob = Number(t.model_predicted_win_prob);
      if (isNaN(prob)) return;

      const pnl = Number(t.pnl) || 0;
      const outcome = pnl > 0 ? 1 : 0;

      brierSum += Math.pow(prob - outcome, 2);
      brierCount += 1;

      for (const bucket of buckets) {
        if (prob >= bucket.min && prob < bucket.max) {
          bucket.n += 1;
          if (outcome === 1) bucket.wins += 1;
          break;
        }
      }
    });

    buckets.forEach(b => {
      b.realizedWR = b.n > 0 ? Number((b.wins / b.n).toFixed(4)) : 0;
    });

    const brierScore = brierCount > 0 ? Number((brierSum / brierCount).toFixed(4)) : null;

    // ── 2. Priors (Latest last_trained per cell: asset + regime + strategy) ──
    const cellMap = new Map();
    let maxLastTrained = null;

    calibrationRows.forEach(row => {
      const cellKey = `${row.asset || 'ALL'}::${row.regime || 'ALL'}::${row.strategy || 'ALL'}`;
      if (!cellMap.has(cellKey)) {
        const metrics = typeof row.metrics === 'object' && row.metrics !== null ? row.metrics : {};
        const winRate = metrics.win_rate ?? metrics.accuracy ?? null;
        const captureRatio = metrics.capture_ratio ?? null;

        cellMap.set(cellKey, {
          asset: row.asset,
          regime: row.regime || 'ALL',
          strategy: row.strategy || 'ALL',
          n: row.sample_count || 0,
          win_rate: winRate !== null ? Number(winRate) : null,
          expected_pnl_mean: row.expected_pnl_mean !== null ? Number(row.expected_pnl_mean) : null,
          capture_ratio: captureRatio !== null ? Number(captureRatio) : null,
          last_trained: row.last_trained
        });
      }

      if (row.last_trained) {
        const t = new Date(row.last_trained).getTime();
        if (!maxLastTrained || t > maxLastTrained) {
          maxLastTrained = t;
        }
      }
    });

    const priors = Array.from(cellMap.values());

    // ── 3. Engine Health ──
    // Staleness: > 8h ago
    const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
    const isTrainerStale = maxLastTrained ? (Date.now() - maxLastTrained > EIGHT_HOURS_MS) : true;
    const trainerStatus = maxLastTrained ? (isTrainerStale ? 'STALE' : 'OK') : 'NOT_INITIALIZED';

    // Shadow portfolio counts (7d)
    const shadowCounts = {
      SAVED: 0,
      MISSED: 0,
      NEUTRAL: 0
    };

    shadowRows.forEach(r => {
      const v = String(r.verdict || '').toUpperCase();
      if (v === 'SAVED') shadowCounts.SAVED += 1;
      else if (v === 'MISSED') shadowCounts.MISSED += 1;
      else shadowCounts.NEUTRAL += 1;
    });

    // Archetype count for tenant assets
    const archetypesCount = archetypes.length;

    return res.status(200).json({
      calibration: {
        totalEvaluated: brierCount,
        brierScore,
        buckets
      },
      priors,
      engineHealth: {
        trainerStatus,
        lastTrained: maxLastTrained ? new Date(maxLastTrained).toISOString() : null,
        shadow: shadowCounts,
        archetypesCount
      }
    });
  } catch (err) {
    console.error('[ENGINE_INTEL_API] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
