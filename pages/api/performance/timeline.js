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
    // PUSH AF1 — shadow in % of veto price (signed sums, computed at read time — no migration)
    shadow_saved_pct: 0, shadow_missed_pct: 0, shadow_net_pct: 0,
    // AG2 — config-true $ (strategy-true sim, signed, from sim_pnl_usd)
    shadow_net_usd: 0,
    veto_saved_count: 0, veto_missed_count: 0, veto_neutral_count: 0,
  };
}

// PUSH AF1 — signed % of veto price for one ledger row, computed at read time.
// SAVED → +(saved_amount / veto_price) * 100 · MISSED → -(missed_amount / veto_price) * 100.
// null when veto_price is null (or zero — division guard).
function movePctOfRow(v) {
  const vp = parseFloat(v.veto_price);
  if (!vp || isNaN(vp) || vp === 0) return null;
  if (v.verdict === 'SAVED') return ((parseFloat(v.saved_amount) || 0) / vp) * 100;
  if (v.verdict === 'MISSED') return -((parseFloat(v.missed_amount) || 0) / vp) * 100;
  return null;
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

  // PUSH AF2 — optional attribution bucket filters: ?asset=&strategy=&tf=&regime=
  // When present, the model query is filtered to the bucket and n_approved/n_flagged
  // are included in the response. trade_logs has no asset/tf columns (trainer mirrors
  // this: asset→symbol, tf→'ANY/ANY'), so tf is accepted but not filterable here.
  const bucketFilters = {};
  if (req.query.asset && req.query.asset !== 'ALL') bucketFilters.asset = String(req.query.asset);
  if (req.query.strategy && req.query.strategy !== 'ALL') bucketFilters.strategy = String(req.query.strategy);
  if (req.query.tf && req.query.tf !== 'ALL') bucketFilters.tf = String(req.query.tf);
  if (req.query.regime && req.query.regime !== 'ALL') bucketFilters.regime = String(req.query.regime);
  const hasBucketFilters = Object.keys(bucketFilters).length > 0;

  try {
    const [tradesRes, shadowRes, toolCallsRes, modelTradesRes] = await Promise.all([
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
        .select('scan_id, asset, signal_direction, verdict, saved_amount, missed_amount, veto_price, veto_regime, fill_basis, macro_tf, trigger_tf, veto_time, sim_exit_price, sim_exit_time, sim_exit_reason, sim_bars, sim_pnl_pts, sim_pnl_usd, sim_params')
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
      // PUSH AF2 — model attribution: model-scored closed trades. SELECT mirrors
      // lib/train-calibration-models.py's trade_logs pull so attribution keys match
      // training buckets exactly (asset→symbol fallback; no tf columns on trade_logs).
      (() => {
        let q = supabase
          .from('trade_logs')
          .select('id, tenant_id, symbol, strategy_id, regime_at_entry, pnl, side, entry_price, exit_price, market_snapshot_at_entry, tp_price, sl_price, exit_time, created_at, model_predicted_win_prob')
          .eq('tenant_id', tenantId)
          .not('model_predicted_win_prob', 'is', null)
          .not('exit_price', 'is', null)
          .not('market_snapshot_at_entry', 'is', null)
          .gte('exit_time', since)
          .order('exit_time', { ascending: true })
          .limit(10000);
        if (bucketFilters.asset) q = q.eq('symbol', bucketFilters.asset);
        if (bucketFilters.strategy) q = q.eq('strategy_id', bucketFilters.strategy);
        if (bucketFilters.regime) q = q.eq('regime_at_entry', bucketFilters.regime);
        return q;
      })(),
    ]);

    const trades = tradesRes.data || [];
    const vetoes = shadowRes.data || [];
    const toolCalls = toolCallsRes.data || [];
    const modelTrades = modelTradesRes.data || []; // PUSH AF2

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
        const excerpt = String(tc.response_summary || '').slice(0, 300);
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
      // PUSH AF1 — signed % of veto price (read-time, no migration)
      const movePct = movePctOfRow(v);
      if (movePct !== null) {
        if (verdict === 'SAVED') buckets[key].shadow_saved_pct += movePct;
        else if (verdict === 'MISSED') buckets[key].shadow_missed_pct += movePct;
      }
      // AG2 — config-true $ (signed sim_pnl_usd; null-safe for legacy rows)
      buckets[key].shadow_net_usd += parseFloat(v.sim_pnl_usd) || 0;
    }

    // PUSH AF2 — model attribution buckets: approved (prob >= 0.5) vs flagged (< 0.5), $ PnL
    const modelBuckets = {}; // date -> { approved_pnl, approved_count, flagged_pnl, flagged_count }
    for (const t of modelTrades) {
      const key = utcDateKey(t.exit_time);
      if (!key) continue;
      if (!modelBuckets[key]) modelBuckets[key] = { approved_pnl: 0, approved_count: 0, flagged_pnl: 0, flagged_count: 0 };
      const pnl = parseFloat(t.pnl) || 0;
      const prob = parseFloat(t.model_predicted_win_prob) || 0;
      if (prob >= 0.5) {
        modelBuckets[key].approved_pnl += pnl;
        modelBuckets[key].approved_count += 1;
      } else {
        modelBuckets[key].flagged_pnl += pnl;
        modelBuckets[key].flagged_count += 1;
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
      // PUSH AF1 — signed pct sums (SAVED positive, MISSED negative)
      buckets[k].shadow_saved_pct = round2(buckets[k].shadow_saved_pct);
      buckets[k].shadow_missed_pct = round2(buckets[k].shadow_missed_pct);
      buckets[k].shadow_net_pct = round2(buckets[k].shadow_saved_pct + buckets[k].shadow_missed_pct);
      // AG2 — config-true $ per day
      buckets[k].shadow_net_usd = round2(buckets[k].shadow_net_usd);
    }
    for (const k of Object.keys(modelBuckets)) {
      modelBuckets[k].approved_pnl = round2(modelBuckets[k].approved_pnl);
      modelBuckets[k].flagged_pnl = round2(modelBuckets[k].flagged_pnl);
    }

    // ── Cumulative series (running sums; only days where the series exists) ──
    const cumLive = [], cumPaper = [], cumShadow = [];
    // PUSH AF1 — cumulative shadow in % of veto price (running sums, % unit)
    const cumShadowSavedPct = [], cumShadowMissedPct = [], cumShadowNetPct = [];
    // AG2 — cumulative config-true $ (strategy-true sim, signed)
    const cumShadowUsd = [];
    // PUSH AF2 — cumulative model attribution ($, real trades)
    const cumModelApproved = [], cumModelFlagged = [];
    let runLive = 0, runPaper = 0, runShadow = 0;
    let runSavedPct = 0, runMissedPct = 0, runNetPct = 0;
    let runShadowUsd = 0;
    let runModelApproved = 0, runModelFlagged = 0;
    for (const k of dayKeys) {
      const b = buckets[k];
      if (b.live_count > 0) { runLive = round2(runLive + b.live_pnl); cumLive.push({ time: k, value: runLive }); }
      if (b.paper_count > 0) { runPaper = round2(runPaper + b.paper_pnl); cumPaper.push({ time: k, value: runPaper }); }
      if (b.veto_saved_count > 0 || b.veto_missed_count > 0 || b.veto_neutral_count > 0) {
        runShadow = round2(runShadow + b.shadow_net);
        cumShadow.push({ time: k, value: runShadow });
        // PUSH AF1 — % unit running sums on the same veto-active days
        runSavedPct = round2(runSavedPct + b.shadow_saved_pct);
        runMissedPct = round2(runMissedPct + b.shadow_missed_pct);
        runNetPct = round2(runSavedPct + runMissedPct);
        cumShadowSavedPct.push({ time: k, value: runSavedPct });
        cumShadowMissedPct.push({ time: k, value: runMissedPct });
        cumShadowNetPct.push({ time: k, value: runNetPct });
        // AG2 — config-true $ running sum on the same veto-active days
        runShadowUsd = round2(runShadowUsd + b.shadow_net_usd);
        cumShadowUsd.push({ time: k, value: runShadowUsd });
      }
      const m = modelBuckets[k];
      if (m && (m.approved_count > 0 || m.flagged_count > 0)) {
        runModelApproved = round2(runModelApproved + m.approved_pnl);
        runModelFlagged = round2(runModelFlagged + m.flagged_pnl);
        cumModelApproved.push({ time: k, value: runModelApproved });
        cumModelFlagged.push({ time: k, value: runModelFlagged });
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
      // PUSH AF1 — totals in % of veto price (signed sums over the window)
      shadow_saved_pct: round2(runSavedPct),
      shadow_missed_pct: round2(runMissedPct),
      shadow_net_pct: round2(runSavedPct + runMissedPct),
      // AG2 — config-true $ total (signed)
      shadow_net_usd: round2(runShadowUsd),
      veto_total: daily.reduce((s, d) => s + d.veto_saved_count + d.veto_missed_count + d.veto_neutral_count, 0),
      // PUSH AF2 — model attribution totals ($, real trades)
      model_approved_pnl: round2(runModelApproved),
      model_approved_count: Object.values(modelBuckets).reduce((s, m) => s + m.approved_count, 0),
      model_flagged_pnl: round2(runModelFlagged),
      model_flagged_count: Object.values(modelBuckets).reduce((s, m) => s + m.flagged_count, 0),
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
        // PUSH AF1 — signed % of veto price, computed at read time (null when veto_price null)
        move_pct: movePctOfRow(v),
        veto_regime: v.veto_regime,
        fill_basis: v.fill_basis,
        macro_tf: v.macro_tf,
        trigger_tf: v.trigger_tf,
        veto_time: v.veto_time,
        // AG2 — strategy-true sim outputs (null for Path A + legacy rows)
        sim_exit_price: v.sim_exit_price,
        sim_exit_time: v.sim_exit_time,
        sim_exit_reason: v.sim_exit_reason,
        sim_bars: v.sim_bars,
        sim_pnl_pts: v.sim_pnl_pts,
        sim_pnl_usd: v.sim_pnl_usd,
        sim_params: v.sim_params,
        reason: rawReason ? rawReason.slice(0, 400) : null,
        tools: toolsByScanId[v.scan_id] || [],
        // 🟢 PUSH AE: telemetry-first — cited memories stamped by sniper at scan time.
        // agent_tool_calls fallback stays for old rows written before the stamp.
        memories: (telemetry && Array.isArray(telemetry.cited_memories) && telemetry.cited_memories.length > 0)
          ? telemetry.cited_memories
          : memoriesByScanId[v.scan_id] || [],
      };
    });

    return res.status(200).json({
      days: daily,
      cumulative: {
        live: cumLive,
        paper: cumPaper,
        shadow: cumShadow,
        // PUSH AF1 — shadow cumulative in % of veto price
        shadowSavedPct: cumShadowSavedPct,
        shadowMissedPct: cumShadowMissedPct,
        shadowNetPct: cumShadowNetPct,
        // AG2 — config-true $ cumulative (strategy-true sim, signed)
        shadowUsd: cumShadowUsd,
        // PUSH AF2 — model attribution cumulative ($)
        modelApproved: cumModelApproved,
        modelFlagged: cumModelFlagged,
      },
      totals,
      vetoes: vetoLedger,
      // PUSH AF2 — per-day model buckets + n counts when a bucket filter is applied
      modelDays: Object.keys(modelBuckets).sort().map(k => ({ date: k, ...modelBuckets[k] })),
      ...(hasBucketFilters ? {
        bucket: bucketFilters,
        n_approved: totals.model_approved_count,
        n_flagged: totals.model_flagged_count,
      } : {}),
    });
  } catch (err) {
    console.error('[performance/timeline] error:', err.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
