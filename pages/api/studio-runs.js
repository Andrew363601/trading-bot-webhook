// pages/api/studio-runs.js
// PUSH AM52a — Studio Episode Theater feed. Read-only, tenant-scoped.
//
// SECURITY: the tenant is derived SERVER-SIDE from the withTenantAuth session
// (AM42 leak class) — NEVER from a client-supplied tenant_id. Do NOT copy the
// manual-JWT auth in pages/api/get-results.js (flagged as a separate hardening
// item, not this push).

import { withTenantAuth } from '../../lib/auth-middleware.js';

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { tenantId, supabase } = req.tenant;

  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  const { data, error } = await supabase
    .from('studio_runs')
    .select('id, run_id, created_at, product, horizon, first_close, run_window, parameters, effective_parameters, summary, regime_breakdown, regime_proxy_version, trades, equity_curve, trigger_candles')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[STUDIO RUNS] fetch error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ runs: data || [] });
}

export default withTenantAuth(handler);
