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
    return res.status(200).json({ configured: false, logs: [], trades: [], configs: [], memories: [], shadowTrades: [] });
  }

  try {
    const [logsRes, tradesRes, configsRes, shadowRes] = await Promise.all([
      supabase
        .from('agent_session_logs')
        .select('agent_name, log_message, log_type, timestamp')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('timestamp', { ascending: false })
        .limit(30),
      supabase
        .from('trade_logs')
        .select('id, symbol, side, strategy_id, entry_price, exit_price, pnl, exit_time, reason, execution_mode, created_at, influencing_memory_ids')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('strategy_config')
        .select('strategy, asset, is_active, execution_mode, last_updated')
        .eq('tenant_id', DEMO_TENANT_ID)
        .eq('is_active', true)   // Only currently-running strategies surface on the landing page.
        .order('last_updated', { ascending: false }),
      // 🟢 PUSH AM36 — shadow ledger rows for the demo tenant. Same safe-column
      // whitelist as pages/api/shadow-trades.js (service-role bypasses RLS, so
      // this list is the only guard). Mapped to the SAME trade-card shape the
      // client already renders (kind: 'SHADOW'). Read-only — no mutations.
      supabase
        .from('shadow_portfolio')
        .select(`
          id, asset, signal_direction, verdict, veto_price, veto_time,
          sim_exit_price, sim_exit_time, sim_exit_reason, sim_pnl_pts,
          sim_pnl_usd, sim_params, created_at
        `)
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    // Fetch linked core memories for all returned trades
    const trades = tradesRes.data || [];
    const allMemoryIds = new Set();
    const allTradeIds = new Set();
    trades.forEach(t => {
      if (t.id) allTradeIds.add(t.id);
      if (t.influencing_memory_ids?.length) {
        t.influencing_memory_ids.forEach(id => allMemoryIds.add(id));
      }
    });
    let memories = [];
    if (allMemoryIds.size > 0 || allTradeIds.size > 0) {
      const ids = [...allMemoryIds];
      const tradeIds = [...allTradeIds];
      const memoryQueries = [];
      if (ids.length > 0) {
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          memoryQueries.push(
            supabase.from('hermes_core_memory').select('*').in('id', chunk).limit(50)
          );
        }
      }
      if (tradeIds.length > 0) {
        for (let i = 0; i < tradeIds.length; i += 50) {
          const chunk = tradeIds.slice(i, i + 50);
          memoryQueries.push(
            supabase.from('hermes_core_memory').select('*').in('trade_log_id', chunk).limit(50)
          );
        }
      }
      const memResults = await Promise.all(memoryQueries);
      memResults.forEach(r => {
        if (r.data) memories = memories.concat(r.data);
      });
    }

    // Fetch tool calls for the demo tenant (all recent — the client joins them
    // to trades via trade_id + time windows, including re-evals on open trades).
    // 🟢 AM16 — public endpoint must expose safe columns only. Service-role
    // bypasses RLS, so the whitelist here is the only guard. Never select('*')
    // on agent_tool_calls: params_snapshot and tenant_id must not leak.
    // 🟢 AM17 — tenant-scoped single query replaces the trade_id chunk loop:
    // pre-trade-only chunking orphaned re-evals (HOLDs) that fire after entry,
    // so open trade cards showed zero tool calls.
    let toolCalls = [];
    {
      const { data } = await supabase.from('agent_tool_calls').select('id, trade_id, tool_name, response_summary, duration_ms, status, created_at').eq('tenant_id', DEMO_TENANT_ID).order('created_at', { ascending: false }).limit(300);
      if (data) toolCalls = data;
    }

    // 🟢 PUSH AM36 — map shadow rows to the shadow-trades.js trade-card shape
    // (identical field names so the demo-index card renders them as-is).
    const shadowTrades = (shadowRes.data || []).map(row => {
      const simParams = row?.sim_params || {};
      return {
        id: row?.id ?? null,
        symbol: row?.asset ?? null,
        side: row?.signal_direction ?? null,
        status: row?.verdict === 'PENDING' ? 'OPEN' : 'CLOSED',
        entry_price: row?.veto_price != null ? parseFloat(row.veto_price) : null,
        exit_price: row?.sim_exit_price != null ? parseFloat(row.sim_exit_price) : null,
        exit_reason: row?.sim_exit_reason ?? null,
        qty: simParams?.qty != null ? simParams.qty : 1000,
        pnl: row?.sim_pnl_usd != null ? parseFloat(row.sim_pnl_usd) : null,
        opened_at: row?.created_at ?? null,
        closed_at: row?.sim_exit_time ?? null,
        tp_price: simParams?.tp_price != null ? simParams.tp_price : null,
        sl_price: simParams?.sl_price != null ? simParams.sl_price : null,
        sim_params: simParams,
        kind: 'SHADOW',
      };
    });

    // Cache at the edge for 10s to keep the landing page snappy and cheap.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

    return res.status(200).json({
      configured: true,
      logs: logsRes.data || [],
      trades,
      configs: configsRes.data || [],
      memories,
      toolCalls,
      shadowTrades,
    });
  } catch (e) {
    console.error('[DEMO_FEED] Error:', e.message);
    return res.status(200).json({ configured: true, logs: [], trades: [], configs: [], memories: [], shadowTrades: [], error: e.message });
  }
}
