// pages/api/shadow-trades.js
// 🟢 PUSH AM10 — Shadow Trades feed: tenant-scoped view of shadow_portfolio
// mapped to the trades-table shape. SIM-ONLY — no mutation endpoints here;
// shadow tickets resolve via their own sim (workers/shadow-portfolio.js).
import { withTenantAuth } from '../../lib/auth-middleware';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // tenant_id comes from the verified session (withTenantAuth) — NEVER query params.
  const { tenantId } = req.tenant;

  try {
    const { data, error } = await supabase
      .from('shadow_portfolio')
      .select(`
        id, asset, signal_direction, verdict, veto_price, veto_time, veto_regime,
        sim_exit_price, sim_exit_time, sim_exit_reason, sim_pnl_pts, sim_pnl_usd,
        sim_bars, sim_params, created_at
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('[SHADOW TRADES] query error:', error.message);
      return res.status(500).json({ error: 'Failed to load shadow trades' });
    }

    const trades = (data || []).map(row => {
      const simParams = row?.sim_params || {};
      return {
        id: row?.id ?? null,
        symbol: row?.asset ?? null,
        side: row?.signal_direction ?? null,
        status: row?.verdict === 'PENDING' ? 'OPEN' : 'CLOSED',
        entry_price: row?.veto_price != null ? parseFloat(row.veto_price) : null,
        exit_price: row?.sim_exit_price != null ? parseFloat(row.sim_exit_price) : null,
        exit_reason: row?.sim_exit_reason ?? null,
        // No qty column on shadow_portfolio — qty lives in sim_params (worker
        // defaults to 1000 notional when absent).
        qty: simParams?.qty != null ? simParams.qty : 1000,
        pnl: row?.sim_pnl_usd != null ? parseFloat(row.sim_pnl_usd) : null,
        opened_at: row?.created_at ?? null,
        closed_at: row?.sim_exit_time ?? null,
        tp_price: simParams?.tp_price != null ? simParams.tp_price : null,
        sl_price: simParams?.sl_price != null ? simParams.sl_price : null,
        kind: 'SHADOW'
      };
    });

    return res.status(200).json({ trades });
  } catch (e) {
    console.error('[SHADOW TRADES] unexpected error:', e.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

export default withTenantAuth(handler);