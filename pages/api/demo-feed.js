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
//
// 🟢 PUSH 7 HOTFIX 3 — THE 4MB FLOOD. This route used to select trade_logs with
// limit(500) (each row carrying the FULL oracle `reason` text) and
// hermes_core_memory with select('*') — unbounded selects that flooded the Vercel
// logs with 4MB+ responses on every landing-page poll. The route is now a FAST
// feed, not a table dump:
//   - every list is capped (FEED_CAPS) and every free-text column is trimmed
//     (TEXT_TRIM) to what the landing page actually renders,
//   - hermes_core_memory selects ONLY the display columns (never select('*')),
//   - scan_results rides along as a SUMMARY-only list (no telemetry blob),
//   - a hard total cap (~1MB) sheds the tail of the heaviest lists if the payload
//     ever grows toward the cap — growth below the cap returns a compact payload.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Support either a server-only var or the existing public var as a fallback.
const DEMO_TENANT_ID =
  process.env.DEMO_TENANT_ID || process.env.NEXT_PUBLIC_DEMO_TENANT_ID;

// 🟢 Push 7 hotfix 3 — per-list row caps. The landing page renders at most ~50
// cards per section; anything past these caps is dead weight on the wire.
const FEED_CAPS = {
  logs: 60,        // agent_session_logs (was 30 — raised + trimmed per row)
  trades: 40,      // trade_logs (was 500 — THE flood)
  configs: 40,     // strategy_config (was UNBOUNDED)
  shadow: 40,      // shadow_portfolio (was 200)
  toolCalls: 120,  // agent_tool_calls (was 300)
  scans: 40,       // scan_results — summary fields ONLY (new; no telemetry blob)
  memoryChunk: 50, // per-chunk hermes_core_memory fetch (chunking unchanged)
};

// �� Push 7 hotfix 3 — free-text trim points. The landing page line-clamps every
// one of these; the full text lives in the DB and in the authenticated views.
const TEXT_TRIM = {
  logMessage: 300,      // agent_session_logs.log_message
  reason: 600,          // trade_logs.reason (oracle reasoning can be 10KB+ per row)
  responseSummary: 200, // agent_tool_calls.response_summary
  lessonLearned: 400,   // hermes_core_memory.lesson_learned
  workingThesis: 400,   // hermes_core_memory.working_thesis
};

// 🟢 Push 7 hotfix 3 — the hard total cap. Under normal operation the caps above
// keep the payload well under 300KB; this is the belt-and-braces ceiling so the
// route can NEVER regress into a table dump.
const HARD_TOTAL_CAP_BYTES = 1024 * 1024; // ~1MB

const trim = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : (s ?? null));

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!DEMO_TENANT_ID) {
    // No demo tenant configured — let the client fall back to synthetic data.
    return res.status(200).json({ configured: false, logs: [], trades: [], configs: [], memories: [], shadowTrades: [], scans: [] });
  }

  try {
    const [logsRes, tradesRes, configsRes, shadowRes, scansRes] = await Promise.all([
      supabase
        .from('agent_session_logs')
        .select('agent_name, log_message, log_type, timestamp')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('timestamp', { ascending: false })
        .limit(FEED_CAPS.logs),
      supabase
        .from('trade_logs')
        .select('id, symbol, side, strategy_id, entry_price, exit_price, pnl, exit_time, reason, execution_mode, created_at, influencing_memory_ids')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(FEED_CAPS.trades),
      supabase
        .from('strategy_config')
        .select('strategy, asset, is_active, execution_mode, last_updated')
        .eq('tenant_id', DEMO_TENANT_ID)
        .eq('is_active', true)   // Only currently-running strategies surface on the landing page.
        .order('last_updated', { ascending: false })
        .limit(FEED_CAPS.configs),
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
        .limit(FEED_CAPS.shadow),
      // 🟢 Push 7 hotfix 3 — scan_results as a SUMMARY feed: id/strategy/asset/
      // status/created_at ONLY. The telemetry jsonb (the multi-KB blob) NEVER
      // crosses this route — the landing page does not render it and the
      // authenticated audit view remains the place to dissect it.
      supabase
        .from('scan_results')
        .select('id, strategy, asset, status, created_at')
        .eq('tenant_id', DEMO_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(FEED_CAPS.scans),
    ]);

    // Fetch linked core memories for all returned trades — DISPLAY COLUMNS ONLY
    // (🟢 Push 7 hotfix 3: this used to be select('*'), pulling every wide text
    // column of hermes_core_memory into a public payload).
    const trades = (tradesRes.data || []).map((t) => ({
      ...t,
      reason: trim(t.reason, TEXT_TRIM.reason),
    }));
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
        for (let i = 0; i < ids.length; i += FEED_CAPS.memoryChunk) {
          const chunk = ids.slice(i, i + FEED_CAPS.memoryChunk);
          memoryQueries.push(
            supabase.from('hermes_core_memory').select('id, trade_log_id, win_loss, regime_at_close, pnl, thesis_accurate, lesson_learned, working_thesis').in('id', chunk).limit(FEED_CAPS.memoryChunk)
          );
        }
      }
      if (tradeIds.length > 0) {
        for (let i = 0; i < tradeIds.length; i += FEED_CAPS.memoryChunk) {
          const chunk = tradeIds.slice(i, i + FEED_CAPS.memoryChunk);
          memoryQueries.push(
            supabase.from('hermes_core_memory').select('id, trade_log_id, win_loss, regime_at_close, pnl, thesis_accurate, lesson_learned, working_thesis').in('trade_log_id', chunk).limit(FEED_CAPS.memoryChunk)
          );
        }
      }
      const memResults = await Promise.all(memoryQueries);
      memResults.forEach(r => {
        if (r.data) memories = memories.concat(r.data);
      });
      memories = memories.map(m => ({
        ...m,
        lesson_learned: trim(m.lesson_learned, TEXT_TRIM.lessonLearned),
        working_thesis: trim(m.working_thesis, TEXT_TRIM.workingThesis),
      }));
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
      const { data } = await supabase.from('agent_tool_calls').select('id, trade_id, tool_name, response_summary, duration_ms, status, created_at').eq('tenant_id', DEMO_TENANT_ID).order('created_at', { ascending: false }).limit(FEED_CAPS.toolCalls);
      if (data) toolCalls = data.map(tc => ({ ...tc, response_summary: trim(tc.response_summary, TEXT_TRIM.responseSummary) }));
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

    const payload = {
      configured: true,
      logs: (logsRes.data || []).map(l => ({ ...l, log_message: trim(l.log_message, TEXT_TRIM.logMessage) })),
      trades,
      configs: configsRes.data || [],
      memories,
      toolCalls,
      shadowTrades,
      scans: scansRes.data || [],
    };

    // 🟢 Push 7 hotfix 3 — the HARD TOTAL CAP. If the payload ever grows past
    // ~1MB (a new wide column, a pathological row), shed the tail of the
    // heaviest list until it fits. Deterministic order: trades are shed LAST —
    // they drive the landing-page stats. Bounded loop (each pass halves one
    // list), floor of 5 rows per list so the page never renders empty.
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > HARD_TOTAL_CAP_BYTES) {
      const shedOrder = ['toolCalls', 'logs', 'scans', 'shadowTrades', 'memories', 'configs', 'trades'];
      for (let guard = 0; guard < 24 && Buffer.byteLength(body) > HARD_TOTAL_CAP_BYTES; guard++) {
        let biggest = null;
        let biggestLen = 0;
        for (const key of shedOrder) {
          const len = Array.isArray(payload[key]) ? payload[key].length : 0;
          if (len > biggestLen) { biggest = key; biggestLen = len; }
        }
        if (!biggest || biggestLen <= 5) break;
        payload[biggest] = payload[biggest].slice(0, Math.max(5, Math.floor(biggestLen / 2)));
        body = JSON.stringify(payload);
      }
      console.warn(`[DEMO_FEED] payload exceeded the ${HARD_TOTAL_CAP_BYTES}B hard cap — shed to ${Buffer.byteLength(body)}B.`);
    }

    // Cache at the edge (30s + SWR) so the landing page stays snappy and the
    // route is invoked far less often — a fast feed, not a per-poll table dump.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).send(body);
  } catch (e) {
    console.error('[DEMO_FEED] Error:', e.message);
    return res.status(200).json({ configured: true, logs: [], trades: [], configs: [], memories: [], shadowTrades: [], scans: [], error: e.message });
  }
}
