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
    return res.status(200).json({ configured: false, logs: [], trades: [], configs: [], memories: [] });
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

    // Fetch tool calls for returned trades
    let toolCalls = [];
    const tradeIds = [...allTradeIds];
    if (tradeIds.length > 0) {
      for (let i = 0; i < tradeIds.length; i += 50) {
        const chunk = tradeIds.slice(i, i + 50);
        const { data } = await supabase.from('agent_tool_calls').select('*').in('trade_id', chunk).order('created_at', { ascending: true }).limit(200);
        if (data) toolCalls = toolCalls.concat(data);
      }
    }

    // Cache at the edge for 10s to keep the landing page snappy and cheap.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

    return res.status(200).json({
      configured: true,
      logs: logsRes.data || [],
      trades,
      configs: configsRes.data || [],
      memories,
      toolCalls,
    });
  } catch (e) {
    console.error('[DEMO_FEED] Error:', e.message);
    return res.status(200).json({ configured: true, logs: [], trades: [], configs: [], memories: [], error: e.message });
  }
}
