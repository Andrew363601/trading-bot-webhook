// pages/api/demo-feed.js
// Public, read-only feed for the marketing landing page (demo-index.js).
//
// WHY THIS EXISTS:
// The landing page is unauthenticated. It used to query trading tables
// (agent_session_logs / trade_logs / strategy_config) directly with the ANON
// Supabase client. Once RLS was tightened to be tenant-scoped, those anonymous
// reads returned nothing — which is why the demo stopped populating.
//
// Best practice (do NOT loosen RLS to expose trading data publicly): instead,
// expose ONLY the demo tenant's data through this server-side endpoint using the
// service role. The demo tenant id is read from server env and never accepted
// from the client, so no arbitrary tenant data can be requested.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Support either a server-only var or the existing public var as a fallback.
const DEMO_TENANT_ID =
  process.env.DEMO_TENANT_ID || process.env.NEXT_PUBLIC_DEMO_TENANT_ID;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!DEMO_TENANT_ID) {
    // No demo tenant configured — let the client fall back to synthetic data.
    return res.status(200).json({ configured: false, logs: [], trades: [], configs: [] });
  }

  try {
    const [logsRes, tradesRes, configsRes] = await Promise.all([
      supabase
        .from('agent_session_logs')
        .select('agent_name, log_message, log_type, timestamp')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('timestamp', { ascending: false })
        .limit(30),
      supabase
        .from('trade_logs')
        .select('symbol, side, strategy_id, entry_price, exit_price, pnl, current_roe, exit_time, created_at')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('strategy_config')
        .select('strategy, asset, is_active, execution_mode, last_updated')
        .eq('tenant_id', DEMO_TENANT_ID)
        .eq('is_active', true)   // Only currently-running strategies surface on the landing page.
        .order('last_updated', { ascending: false }),
    ]);

    // Cache at the edge for 10s to keep the landing page snappy and cheap.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

    return res.status(200).json({
      configured: true,
      logs: logsRes.data || [],
      trades: tradesRes.data || [],
      configs: configsRes.data || [],
    });
  } catch (e) {
    console.error('[DEMO_FEED] Error:', e.message);
    return res.status(200).json({ configured: true, logs: [], trades: [], configs: [], error: e.message });
  }
}
