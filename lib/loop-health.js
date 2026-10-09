// lib/loop-health.js
// 🟢 PUSH AM62 — pure weekly bucketing for the Learning Loop panel (no I/O).
//
// Extracted so the derivation is unit-testable without a DB (mirrors the AM53/
// AM61 pattern of pure helpers). pages/api/performance/loop-health.js does the
// Supabase reads and passes rows in; everything numeric happens here.

export const ROLLING_WINDOW = 20;
export const DEFAULT_WEEKS = 12;
function round1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ISO-week start (Monday) as a UTC YYYY-MM-DD string. UTC keeps week keys
// deterministic regardless of the server TZ; the client plots the key verbatim.
export function isoWeekKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const ws = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return ws.toISOString().slice(0, 10);
}

// 🟢 AM62b — UTC calendar-day key (YYYY-MM-DD). Used only when the endpoint is
// asked for granularity=day; the default weekly path below is unchanged.
export function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function emptyBucket(week) {
  return {
    week,
    n: 0, wins: 0, pnl: 0,
    predicted_sum: 0, predicted_n: 0,
    agent_adjusted_count: 0,
    structure_long: 0, structure_short: 0, structure_neutral: 0,
    lessons_written: 0, score_sum: 0, score_n: 0,
    rolling20: null,
  };
}

// trades:  [{ pnl, exit_time, model_predicted_win_prob, params_context, structure_direction }] ASC by exit_time
// lessons: [{ created_at, lesson_score }]
// opts:    { granularity: 'week' | 'day' } (default 'week' — byte-identical to pre-AM62b)
// Returns { weeks, series, totals }. (The bucket field is still named `week` for
// the default path; at granularity=day it holds the YYYY-MM-DD day key.)
export function deriveLoopHealth(trades = [], lessons = [], opts = {}) {
  const keyOf = (opts && opts.granularity === 'day') ? dayKey : isoWeekKey;
  const buckets = new Map();
  const ensure = (k) => {
    if (!buckets.has(k)) buckets.set(k, emptyBucket(k));
    return buckets.get(k);
  };

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const k = keyOf(t.exit_time);
    if (!k) continue;
    const b = ensure(k);
    const pnl = parseFloat(t.pnl);
    const okPnl = Number.isFinite(pnl);

    b.n += 1;
    if (okPnl && pnl > 0) b.wins += 1;
    if (okPnl) b.pnl += pnl;

    const prob = parseFloat(t.model_predicted_win_prob);
    if (Number.isFinite(prob)) { b.predicted_sum += prob; b.predicted_n += 1; }

    if (t.params_context && t.params_context.agent_adjusted === true) b.agent_adjusted_count += 1;

    const sd = t.structure_direction;
    if (sd === 'LONG') b.structure_long += 1;
    else if (sd === 'SHORT') b.structure_short += 1;
    else if (sd === 'NEUTRAL') b.structure_neutral += 1;

    // Rolling-20 win rate ending at this trade (trailing window wins/total).
    const lo = Math.max(0, i - ROLLING_WINDOW + 1);
    let w = 0, c = 0;
    for (let j = lo; j <= i; j++) {
      const p = parseFloat(trades[j].pnl);
      if (!Number.isFinite(p)) continue;
      c += 1;
      if (p > 0) w += 1;
    }
    if (c > 0) b.rolling20 = (w / c) * 100; // last trade of the week wins
  }

  for (const m of lessons) {
    const k = keyOf(m.created_at);
    if (!k) continue;
    const b = ensure(k);
    b.lessons_written += 1;
    const s = Number(m.lesson_score);
    if (Number.isFinite(s)) { b.score_sum += s; b.score_n += 1; }
  }

  let runningPnl = 0;
  const weeks = [...buckets.values()]
    .sort((a, b) => (a.week < b.week ? -1 : 1))
    .map((b) => {
      const win_rate = b.n > 0 ? round1((b.wins / b.n) * 100) : null;
      const avg_predicted_prob = b.predicted_n > 0 ? round1((b.predicted_sum / b.predicted_n) * 100) : null;
      const avg_pnl = b.n > 0 ? round2(b.pnl / b.n) : null;
      runningPnl += b.pnl;
      return {
        week: b.week,
        n: b.n,
        wins: b.wins,
        win_rate,
        realized_win_rate: win_rate,
        avg_pnl,
        cumulative_pnl: round2(runningPnl),
        avg_predicted_prob,
        agent_adjusted_count: b.agent_adjusted_count,
        lessons_written: b.lessons_written,
        avg_score: b.score_n > 0 ? round1(b.score_sum / b.score_n) : null,
        rolling20: b.rolling20 != null ? round1(b.rolling20) : null,
        structure: { LONG: b.structure_long, SHORT: b.structure_short, NEUTRAL: b.structure_neutral },
      };
    });

  const series = {
    realized: weeks.filter((w) => w.realized_win_rate != null).map((w) => ({ time: w.week, value: w.realized_win_rate })),
    rolling20: weeks.filter((w) => w.rolling20 != null).map((w) => ({ time: w.week, value: w.rolling20 })),
    predicted: weeks.filter((w) => w.avg_predicted_prob != null).map((w) => ({ time: w.week, value: w.avg_predicted_prob })),
    lessons: weeks.map((w) => ({ time: w.week, value: w.lessons_written })),
    agentAdjusted: weeks.map((w) => ({ time: w.week, value: w.agent_adjusted_count })),
  };

  const totalTrades = weeks.reduce((a, w) => a + w.n, 0);
  const totalWins = weeks.reduce((a, w) => a + w.wins, 0);
  const totalPredN = weeks.reduce((a, w) => a + (w.avg_predicted_prob != null ? w.n : 0), 0);
  const weightedPred = weeks.reduce((a, w) => a + (w.avg_predicted_prob != null ? w.avg_predicted_prob * w.n : 0), 0);
  const realized = totalTrades > 0 ? round1((totalWins / totalTrades) * 100) : null;
  const predicted = totalPredN > 0 ? round1(weightedPred / totalPredN) : null;

  const totals = {
    trades: totalTrades,
    wins: totalWins,
    win_rate: realized,
    pnl: round2(weeks.reduce((a, w) => a + w.pnl, 0)),
    predicted_prob: predicted,
    // The honesty gap: model confidence minus realized outcome (points).
    honesty_gap: (predicted != null && realized != null) ? round1(predicted - realized) : null,
    lessons: weeks.reduce((a, w) => a + w.lessons_written, 0),
    agent_adjusted: weeks.reduce((a, w) => a + w.agent_adjusted_count, 0),
    weeks_with_data: weeks.filter((w) => w.n > 0).length,
  };

  return { weeks, series, totals };
}
