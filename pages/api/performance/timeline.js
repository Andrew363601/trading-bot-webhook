// pages/api/performance/timeline.js
// PUSH AB — Performance Timeline: daily PnL (Live/Paper/Shadow) + Veto Ledger.
// Auth exactly like pages/api/engine-intel.js.

import { verifyTenantContext } from '../../../lib/auth-middleware';

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function emptyBucket() {
  return {
    live_pnl: 0, live_count: 0,
    paper_pnl: 0, paper_count: 0,
    shadow_saved: 0, shadow_missed: 0, shadow_net: 0,
    veto_saved_count: 0, veto_missed_count: 0, veto_neutral_count: 0,
  };
}

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

  // ?days= clamp 1..90 (default 30)
  let days = parseInt(req.query.days, 10);
  if (isNaN(days) || days < 1) days = 30;
  if (days > 90) days = 90;
  const since = new Date(Date.now() - days * DAY_MS).toISOString();

  try {
    const [tradesRes, shadowRes, toolCallsRes] = await Promise.all([
      // A) Closed trades (exit_price present ⇒ closed)
      supabase
        .from('trade_logs')
        .select('pnl, exit_time, execution_mode')
        .eq('tenant_id', tenantId)
        .not('exit_price', 'is', null)
        .gte('exit_time', since)
        .order('exit_time', { ascending: true })
        .limit(10000),
      // B) Shadow portfolio rows (one veto per row)
      supabase
        .from('shadow_portfolio')
        .select('scan_id, asset, signal_direction, verdict, saved_amount, missed_amount, veto_price, veto_regime, fill_basis, macro_tf, trigger_tf, veto_time')
        .eq('tenant_id', tenantId)
        .gte('veto_time', since)
        .order('veto_time', { ascending: true })
        .limit(2000),
      // D) Tool calls over the window (matched to vetoes by scan_id later)
      supabase
        .from('agent_tool_calls')
        .select('scan_id, tool_name, response_summary')
        .eq('tenant_id', tenantId)
        .gte('created_at', since)
        .limit(5000),
    ]);

    const trades = tradesRes.data || [];
    const vetoes = shadowRes.data || [];
    const toolCalls = toolCallsRes.data || [];

    // C) scan_results telemetry for veto reasons — chunked .in() by 50.
    // Degrade silently: on any error, vetoes still return with reason: null.
    const scanIds = [...new Set(vetoes.map(v => v.scan_id).filter(id => id !== null && id !== undefined))];
    const telemetryById = {};
    if (scanIds.length > 0) {
      try {
        const scanChunks = [];
        for (let i = 0; i < scanIds.length; i += 50) {
          scanChunks.push(scanIds.slice(i, i + 50));
        }
        const scanResults = await Promise.all(
          scanChunks.map(chunk =>
            supabase
              .from('scan_results')
              .select('id, telemetry')
              .in('id', chunk)
          )
        );
        for (const r of scanResults) {
          if (r.error) throw r.error;
          for (const row of r.data || []) {
            telemetryById[row.id] = row.telemetry || null;
          }
        }
      } catch (e) {
        console.error('[performance/timeline] scan_results chunk fetch failed:', e.message || e);
        // telemetryById stays empty — reasons degrade to null
      }
    }

    // tool_name index by scan_id (unique, insertion order) — NON-memory tools only
    const toolsByScanId = {};
    const memoriesByScanId = {};
    const memorySeen = {};
    for (const tc of toolCalls) {
      if (tc.scan_id === null || tc.scan_id === undefined) continue;
      const isMemory = (tc.tool_name || '').toLowerCase().includes('memory');
      if (isMemory) {
        if (!memoriesByScanId[tc.scan_id]) { memoriesByScanId[tc.scan_id] = []; memorySeen[tc.scan_id] = new Set(); }
        const excerpt = (tc.response_summary || '').slice(0, 300);
        if (excerpt && !memorySeen[tc.scan_id].has(excerpt) && memoriesByScanId[tc.scan_id].length < 3) {
          memorySeen[tc.scan_id].add(excerpt);
          memoriesByScanId[tc.scan_id].push({ excerpt });
        }
        continue;
      }
      if (!toolsByScanId[tc.scan_id]) toolsByScanId[tc.scan_id] = [];
      if (!toolsByScanId[tc.scan_id].includes(tc.tool_name)) {
        toolsByScanId[tc.scan_id].push(tc.tool_name);
      }
    }

    // ── Aggregate by UTC date ──
    const buckets = {}; // date -> bucket

    for (const t of trades) {
      const key = utcDateKey(t.exit_time);
      if (!key) continue;
      if (!buckets[key]) buckets[key] = emptyBucket();
      const pnl = parseFloat(t.pnl) || 0;
      const mode = (t.execution_mode || '').toUpperCase();
      if (mode === 'LIVE') {
        buckets[key].live_pnl += pnl;
        buckets[key].live_count += 1;
      } else if (mode === 'PAPER') {
        buckets[key].paper_pnl += pnl;
        buckets[key].paper_count += 1;
      } else {
        // Unknown mode — bucket under paper (execution_mode is only 'LIVE'|'PAPER')
        buckets[key].paper_pnl += pnl;
        buckets[key].paper_count += 1;
      }
    }

    for (const v of vetoes) {
      const key = utcDateKey(v.veto_time);
      if (!key) continue;
      if (!buckets[key]) buckets[key] = emptyBucket();
      const verdict = v.verdict;
      if (verdict === 'SAVED') {
        buckets[key].shadow_saved += parseFloat(v.saved_amount) || 0;
        buckets[key].veto_saved_count += 1;
      } else if (verdict === 'MISSED') {
        buckets[key].shadow_missed += parseFloat(v.missed_amount) || 0;
        buckets[key].veto_missed_count += 1;
      } else {
        buckets[key].veto_neutral_count += 1;
      }
    }

    const dayKeys = Object.keys(buckets).sort();
    for (const k of dayKeys) {
      buckets[k].shadow_net = buckets[k].shadow_saved - buckets[k].shadow_missed;
      buckets[k].live_pnl = round2(buckets[k].live_pnl);
      buckets[k].paper_pnl = round2(buckets[k].paper_pnl);
      buckets[k].shadow_saved = round2(buckets[k].shadow_saved);
      buckets[k].shadow_missed = round2(buckets[k].shadow_missed);
      buckets[k].shadow_net = round2(buckets[k].shadow_net);
    }

    // ── Cumulative series (running sums; only days where the series exists) ──
    const cumLive = [], cumPaper = [], cumShadow = [];
    let runLive = 0, runPaper = 0, runShadow = 0;
    for (const k of dayKeys) {
      const b = buckets[k];
      if (b.live_count > 0) { runLive = round2(runLive + b.live_pnl); cumLive.push({ time: k, value: runLive }); }
      if (b.paper_count > 0) { runPaper = round2(runPaper + b.paper_pnl); cumPaper.push({ time: k, value: runPaper }); }
      if (b.veto_saved_count > 0 || b.veto_missed_count > 0 || b.veto_neutral_count > 0) {
        runShadow = round2(runShadow + b.shadow_net);
        cumShadow.push({ time: k, value: runShadow });
      }
    }

    const daily = dayKeys.map(k => ({ date: k, ...buckets[k] }));

    // ── Totals ──
    const totals = {
      live_pnl: round2(runLive),
      live_count: daily.reduce((s, d) => s + d.live_count, 0),
      paper_pnl: round2(runPaper),
      paper_count: daily.reduce((s, d) => s + d.paper_count, 0),
      shadow_saved: round2(daily.reduce((s, d) => s + d.shadow_saved, 0)),
      shadow_missed: round2(daily.reduce((s, d) => s + d.shadow_missed, 0)),
      shadow_net: round2(runShadow),
      veto_total: daily.reduce((s, d) => s + d.veto_saved_count + d.veto_missed_count + d.veto_neutral_count, 0),
    };

    // ── Vetoes ledger: most recent 200, desc ──
    const vetoesDesc = [...vetoes].sort((a, b) => new Date(b.veto_time) - new Date(a.veto_time)).slice(0, 200);
    const vetoLedger = vetoesDesc.map(v => {
      const telemetry = v.scan_id !== null && v.scan_id !== undefined ? telemetryById[v.scan_id] : null;
      const rawReason = telemetry && typeof telemetry.oracle_reasoning === 'string' ? telemetry.oracle_reasoning : null;
      return {
        scan_id: v.scan_id,
        asset: v.asset,
        signal_direction: v.signal_direction,
        verdict: v.verdict,
        saved_amount: v.saved_amount,
        missed_amount: v.missed_amount,
        veto_price: v.veto_price,
        veto_regime: v.veto_regime,
        fill_basis: v.fill_basis,
        macro_tf: v.macro_tf,
        trigger_tf: v.trigger_tf,
        veto_time: v.veto_time,
        reason: rawReason ? rawReason.slice(0, 400) : null,
        tools: toolsByScanId[v.scan_id] || [],
        memories: memoriesByScanId[v.scan_id] || [],
      };
    });

    return res.status(200).json({
      days: daily,
      cumulative: { live: cumLive, paper: cumPaper, shadow: cumShadow },
      totals,
      vetoes: vetoLedger,
    });
  } catch (err) {
    console.error('[performance/timeline] error:', err.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
