// pages/api/performance/loop-health.js
// PUSH AM62 — Learning Loop panel data.
//
// Weekly (last 12 ISO weeks) closed-trade TRUTH vs the model's own ENTRY
// confidence — the "honesty gap" — plus lessons written and agent-adjusted
// entries. Server-side derivation ONLY: the panel renders exactly what this
// endpoint returns (no client-side score re-derivation).
//
// Auth exactly like pages/api/performance/timeline.js (verifyTenantContext).
//
// Sources:
//   trade_logs          — closed trades (exit_price present), bucketed on exit_time.
//                         n, win_rate, avg_pnl, cumulative_pnl, avg_predicted_prob
//                         (model_predicted_win_prob at entry), realized_win_rate,
//                         agent_adjusted_count (params_context.agent_adjusted),
//                         structure_direction tallies (AM62 c2), rolling-20 win rate.
//   hermes_core_memory  — lessons_written + avg lesson_score per week (AM62 c1),
//                         bucketed on created_at.
//
// Safety nets mirror AM53/AM61: if a NEW column is not yet migrated (059), the
// affected query retries WITHOUT that column so the panel degrades to fewer
// series instead of going blank.

import { verifyTenantContext } from '../../../lib/auth-middleware';
import { deriveLoopHealth, isoWeekKey, DEFAULT_WEEKS } from '../../../lib/loop-health';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_WEEKS = 52;
const ROW_CAP = 50000;

// AM62 — deploy event markers (config constant list). Rendered as vertical event
// markers on the panel's weekly axis so a shift in the honesty gap can be
// attributed to a shipped change. Adding an entry is the ONLY edit needed to
// surface a new deploy. Times are ISO calendar dates (YYYY-MM-DD) and should
// coincide with an ISO-week start the panel actually plots.
export const DEPLOY_EVENTS = [
  { time: '2026-09-26', label: 'AM46' },
  { time: '2026-10-05', label: 'AM57' },
  { time: '2026-10-07', label: 'AM59-61' },
];

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

  // ?weeks= clamp 4..52 (default 12)
  let weeks = parseInt(req.query.weeks, 10);
  if (isNaN(weeks) || weeks < 4) weeks = DEFAULT_WEEKS;
  if (weeks > MAX_WEEKS) weeks = MAX_WEEKS;
  const since = new Date(Date.now() - weeks * WEEK_MS).toISOString();
  const windowMeta = { weeks, start: since, end: new Date().toISOString() };

  try {
    // ── Trades query (with structure_direction; safety-net retry without it) ──
    const tradeSelect = 'pnl, exit_time, model_predicted_win_prob, params_context, structure_direction';
    let tradesRes = await supabase
      .from('trade_logs')
      .select(tradeSelect)
      .eq('tenant_id', tenantId)
      .not('exit_price', 'is', null)
      .gte('exit_time', since)
      .order('exit_time', { ascending: true })
      .limit(ROW_CAP);
    if (tradesRes.error && /structure_direction/i.test(tradesRes.error.message || '')) {
      // 🛡️ AM62 SAFETY NET — pre-059 DB: drop structure_direction, keep the panel.
      console.warn('[loop-health] trade_logs select rejected structure_direction — retrying without it.');
      tradesRes = await supabase
        .from('trade_logs')
        .select('pnl, exit_time, model_predicted_win_prob, params_context')
        .eq('tenant_id', tenantId)
        .not('exit_price', 'is', null)
        .gte('exit_time', since)
        .order('exit_time', { ascending: true })
        .limit(ROW_CAP);
    }

    // ── Lessons query (with lesson_score; safety-net retry without it) ──
    let memoryRes = await supabase
      .from('hermes_core_memory')
      .select('created_at, lesson_score')
      .eq('tenant_id', tenantId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(ROW_CAP);
    if (memoryRes.error && /lesson_score/i.test(memoryRes.error.message || '')) {
      // 🛡️ AM62 SAFETY NET — pre-059 DB: drop lesson_score (avg_score → null).
      console.warn('[loop-health] hermes_core_memory select rejected lesson_score — retrying without it.');
      memoryRes = await supabase
        .from('hermes_core_memory')
        .select('created_at')
        .eq('tenant_id', tenantId)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(ROW_CAP);
    }

    const trades = tradesRes.data || [];
    const lessons = memoryRes.data || [];
    const truncatedBy = {
      trades: trades.length >= ROW_CAP,
      lessons: lessons.length >= ROW_CAP,
    };

    const { weeks: weekRows, series, totals } = deriveLoopHealth(trades, lessons);

    return res.status(200).json({
      weeks: weekRows,
      series,
      events: DEPLOY_EVENTS,
      totals,
      window: windowMeta,
      truncated: Object.values(truncatedBy).some(Boolean),
      truncatedBy,
    });
  } catch (err) {
    console.error('[performance/loop-health] error:', err?.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

