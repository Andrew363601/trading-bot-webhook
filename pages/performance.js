import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
// 🟢 THE FIX: Explicitly import AreaSeries for V5 compatibility
import { createChart, AreaSeries, LineSeries, LineStyle } from 'lightweight-charts';
import { 
  BarChart3, Calendar, Target, TrendingUp, TrendingDown, Clock, BrainCircuit, LineChart, Lightbulb, Layers, Activity, ChevronDown, ChevronUp, Crosshair, ShieldAlert
} from 'lucide-react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { createServerSupabaseClient } from '@supabase/auth-helpers-nextjs';
import { getTierInfo, getStageColor } from '../lib/tier-mapping';

// PUSH AC — local YYYY-MM-DD at module scope (component has its own copy for
// back-compat; helpers here run outside the component tree).
function localDateStr(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

// PUSH AC — ISO-week start (Monday) for the calendar WEEK granularity.
function isoWeekStart(d) {
  const dt = new Date(d);
  const day = (dt.getDay() + 6) % 7; // 0 = Monday
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - day);
}

// PUSH AC — collapse a daily cumulative series into ISO-week buckets.
// Cumulative across weeks: the last day's value in each week wins.
function weeklyCumulative(daily) {
  const byWeek = new Map();
  for (const pt of daily || []) {
    if (!pt?.time) continue;
    const wsKey = localDateStr(isoWeekStart(new Date(`${pt.time}T00:00:00`)));
    byWeek.set(wsKey, pt.value); // later days overwrite — last value = week-end cumulative
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, value]) => ({ time: k, value }));
}

// PUSH AC — short-form TF label (timeframe_4H → 4h)
const shortTf = (tf) => (tf ? String(tf).replace('timeframe_', '').replace('1H', '1h').replace('4H', '4h').replace('1D', '1d') : null);

// AG2 — exit-reason chip styling (TP/SL/TRAIL/TRIPWIRE/HORIZON; slate default for unknown)
const exitReasonChip = {
  TP: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  SL: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
  TRAIL: 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300',
  TRIPWIRE: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  HORIZON: 'bg-slate-800 border-white/10 text-slate-400',
};

// PUSH AC — shared Shadow Ledger card (used by the Veto Ledger section AND the
// SHADOW-mode log list). Mirrors the closed-trade card styling: header row,
// chips, expandable reason, indigo CORE MEMORIES block, tool chips.
function ShadowLedgerCard({ v, expandedKey, expandedMap, onToggle }) {
  const verdict = v.verdict || 'NEUTRAL';
  const isBuy = v.signal_direction === 'BUY';
  const savedAmt = parseFloat(v.saved_amount) || 0;
  const missedAmt = parseFloat(v.missed_amount) || 0;
  const rawAmount = verdict === 'SAVED' ? savedAmt : verdict === 'MISSED' ? missedAmt : 0;
  // amounts = price points per 1 unit (NOT dollars) — unified across both paths
  const amountLabel =
    verdict === 'SAVED' ? `+${savedAmt.toFixed(2)} pts`
    : verdict === 'MISSED' ? `−${missedAmt.toFixed(2)} pts`
    : '0.00 pts';
  const basePrice = v.veto_price !== null && v.veto_price !== undefined ? parseFloat(v.veto_price) : null;
  const pctOfPrice = basePrice ? (rawAmount / basePrice) * 100 : null;
  const isExpanded = !!expandedMap[expandedKey];
  const memories = v.memories || [];
  const macroShort = shortTf(v.macro_tf);
  const triggerShort = shortTf(v.trigger_tf);
  const timeStr = v.veto_time ? new Date(v.veto_time).toLocaleTimeString() : (v.created_at ? new Date(v.created_at).toLocaleTimeString() : '');
  const verdictChip =
    verdict === 'SAVED' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
    : verdict === 'MISSED' ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
    : 'bg-slate-800 border-white/10 text-slate-400';

  return (
    <div className="p-4 rounded-2xl border bg-slate-900/60 border-white/5 transition-all duration-300">
      {/* Header: time · asset · direction · verdict — mirrors closed-trade cards */}
      <div className="flex flex-wrap justify-between items-center mb-3 border-b border-white/5 pb-3 gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] text-slate-500 font-mono">{timeStr}</span>
          <span className="text-sm font-bold text-white">{v.asset || '—'}</span>
          {isBuy ? (
            <span className="text-[11px] font-black text-emerald-400">BUY ▲</span>
          ) : (
            <span className="text-[11px] font-black text-rose-400">SELL ▼</span>
          )}
          <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border ${verdictChip}`}>{verdict}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-black font-mono text-sm ${verdict === 'SAVED' ? 'text-emerald-400' : verdict === 'MISSED' ? 'text-rose-400' : 'text-slate-400'}`}>
            {amountLabel}{pctOfPrice ? ` (${pctOfPrice.toFixed(1)}%)` : ''}
          </span>
        </div>
      </div>

      {/* Chips: regime · TF pair · fill basis */}
      <div className="flex flex-wrap items-center gap-2 text-[9px] md:text-[10px] font-mono mb-1">
        {v.veto_regime && <span className="text-slate-500 uppercase tracking-wider">{v.veto_regime}</span>}
        {(macroShort || triggerShort) && (
          <span className="text-slate-500">TF {macroShort || '?'}{triggerShort ? `/${triggerShort}` : ''}</span>
        )}
        {v.fill_basis === 'far_side' && (
          <span className="px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-indigo-500/10 border border-indigo-500/30 text-indigo-300">far side</span>
        )}
        {v.fill_basis === 'mid_legacy' && (
          <span className="px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-amber-500/10 border border-amber-500/30 text-amber-300">legacy</span>
        )}
        {v.veto_price !== null && v.veto_price !== undefined && (
          <span className="text-slate-600">@ {Number(v.veto_price)}</span>
        )}
      </div>

      {/* Reason (oracle_reasoning) — expandable, same pattern as expandedThesis */}
      {v.reason && (
        <div className="border-l-2 border-amber-500/30 pl-4 py-1 mt-2">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2">Oracle Reasoning</h4>
            {String(v.reason).length > 140 && (
              <button
                onClick={() => onToggle(expandedKey)}
                className="text-[9px] font-black uppercase tracking-widest text-amber-300 hover:text-amber-200 flex items-center gap-1"
              >
                {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>Expand <ChevronDown size={10}/></>}
              </button>
            )}
          </div>
          <p className={`text-[11px] text-slate-400 italic whitespace-pre-wrap ${isExpanded ? '' : 'line-clamp-3'}`}>
            {String(v.reason)}
          </p>
        </div>
      )}

      {/* CORE MEMORIES — styled like the per-trade Core Memory (Influenced) block (indigo) */}
      {memories.length > 0 && (() => {
        const memKey = `${expandedKey}-memories`;
        const memExpanded = !!expandedMap[memKey];
        return (
          <div className="border-l-2 border-indigo-500/30 pl-4 py-1 mt-2">
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-[9px] font-black uppercase tracking-widest text-indigo-400 flex items-center gap-2">
                🧠 Core Memories
              </h4>
              <button
                onClick={() => onToggle(memKey)}
                className="text-[9px] font-black uppercase tracking-widest text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
              >
                {memExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {memories.length} <ChevronDown size={10}/></>}
              </button>
            </div>
            {memExpanded && (
              <div className="space-y-2 mt-2">
                {memories.map((m, mi) => (
                  <div key={mi} className="bg-black/30 rounded-lg p-3 border border-indigo-500/10">
                    <p className="text-[11px] text-slate-400 italic leading-relaxed line-clamp-3">{m.excerpt}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Tool chips (non-memory tools only — API already excludes memory tools) */}
      {(v.tools || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-2">
          {v.tools.map(t => (
            <span key={t} className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-slate-800/60 border border-white/10 text-slate-400">{t}</span>
          ))}
        </div>
      )}

      {/* Counterfactual note (old shadow_portfolio rows only) */}
      {v.counterfactual_direction && (
        <div className="mt-2 text-[9px] text-slate-500 font-mono pl-2">
          No trade found — price moved <span className={v.counterfactual_direction === 'WENT_AGAINST' ? 'text-emerald-400' : 'text-red-400'}>{v.counterfactual_direction.replace('_', ' ')}</span> within 6h
        </div>
      )}

      {/* AG2 — strategy-true sim: entry → exit line + exit-reason chip + bars + config-$ */}
      {v.sim_exit_price !== null && v.sim_exit_price !== undefined && (() => {
        const simKey = `${expandedKey}-sim`;
        const simExpanded = !!expandedMap[simKey];
        const exitChip = exitReasonChip[v.sim_exit_reason] || exitReasonChip.HORIZON;
        const simUsd = parseFloat(v.sim_pnl_usd);
        const entryP = basePrice;
        const exitP = parseFloat(v.sim_exit_price);
        const exitTimeStr = v.sim_exit_time ? new Date(v.sim_exit_time).toLocaleString() : '';
        return (
          <div className="mt-2 border-l-2 border-slate-500/30 pl-4 py-1">
            <div className="flex flex-wrap items-center gap-2 text-[9px] md:text-[10px] font-mono">
              <span className="text-slate-400">sim: {entryP != null ? Number(entryP).toFixed(2) : '?'} → <span className="text-white">{Number(exitP).toFixed(2)}</span></span>
              {exitTimeStr && <span className="text-slate-600">@ {exitTimeStr}</span>}
              <span className={`px-2 py-0.5 rounded-full font-black uppercase tracking-wider border ${exitChip}`}>{v.sim_exit_reason || 'HORIZON'}</span>
              {v.sim_bars != null && <span className="text-slate-500">{v.sim_bars} bars</span>}
              {Number.isFinite(simUsd) && (
                <span className={`font-black ${simUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  config-$ {simUsd >= 0 ? '+' : '−'}${Math.abs(simUsd).toFixed(2)}
                </span>
              )}
              {v.sim_params && (
                <button
                  onClick={() => onToggle(simKey)}
                  className="text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  {simExpanded ? <>rules <ChevronUp size={10}/></> : <>rules <ChevronDown size={10}/></>}
                </button>
              )}
            </div>
            {simExpanded && v.sim_params && (
              <div className="mt-2 bg-black/30 rounded-lg p-3 border border-white/10">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Sim Rules (config-true)</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[9px] font-mono text-slate-400">
                  {Object.entries(v.sim_params).map(([k, val]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-slate-600">{k}</span>
                      <span className="text-slate-300 truncate">{val === null || val === undefined ? '—' : String(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export default function PerformanceLog({ initialSession }) {
  const session = useSession() || initialSession;
  
  if (!session) {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  return <PerformanceLogContent />;
}

export async function getServerSideProps(context) {
  const supabase = createServerSupabaseClient(context);
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    return { redirect: { destination: '/auth', permanent: false } };
  }

  return { props: { initialSession: session } };
}

function PerformanceLogContent() {
  const [isMounted, setIsMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const supabase = useSupabaseClient();
  const session = useSession();
  const [tenantId, setTenantId] = useState(null);
  
  const [allValidTrades, setAllValidTrades] = useState([]);
  
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [strategyFilter, setStrategyFilter] = useState('ALL');
  const [modeFilter, setModeFilter] = useState('ALL'); // ALL | LIVE | PAPER
  const [selectedDate, setSelectedDate] = useState(null);
  // AH3 — explicit-day flag: the auto-selected "today" drives the trade log,
  // but the Shadow Ledger defaults to NO day filter (last 30d) because with
  // the 24h sim horizon, today's shadow rows only appear as sims resolve.
  // The calendar day-filter applies to the ledger ONLY when the user
  // explicitly clicks a day.
  const [explicitDaySelected, setExplicitDaySelected] = useState(false);
  const [logFilter, setLogFilter] = useState('ALL');

  // 🟢 Shadow Portfolio: fetch VETO labels
  const [shadowRecords, setShadowRecords] = useState([]); // legacy raw rows (tab count now uses timeline.totals.veto_total)
  const [showVetos, setShowVetos] = useState(false); // PUSH AD — false = LOGS tab, true = 🛡️ SHADOW LEDGER tab (also drives timeline shadow curve)
  // AH2 — LOGS / SHADOW LEDGER are now INDEPENDENT toggle chips (both can be
  // active; default BOTH on). showVetos stays the source of truth for the
  // timeline chart series; these chips only control list/ledger visibility.
  const [showLogs, setShowLogs] = useState(true);
  const [showShadowLedger, setShowShadowLedger] = useState(true);
  const [riskBlocks, setRiskBlocks] = useState([]);
  const [showRiskBlocks, setShowRiskBlocks] = useState(false);
  const [toolCallsMap, setToolCallsMap] = useState({});

  // Per-row toggle for the (often very long) oracle rationale. Keyed by trade.id.
  const [expandedThesis, setExpandedThesis] = useState({});
  // 🟢 Tracks expanded core memories per trade
  const [expandedMemories, setExpandedMemories] = useState({});
  // 🟢 Cache of core memories keyed by trade_log_id for reverse lookup
  const [linkedMemories, setLinkedMemories] = useState({});
  // In-flight ids for the action buttons so the UI can disable them while a request runs.
  const [reviewingId, setReviewingId] = useState(null);
  const [closingId, setClosingId] = useState(null);
  // Real calendar: track the visible month (first of month).
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Engine Intelligence state
  const [engineIntel, setEngineIntel] = useState(null);
  const [engineIntelLoading, setEngineIntelLoading] = useState(true);

  // PUSH AC — Performance Timeline state (⏱️ Performance Timeline + 🛡️ Shadow Ledger)
  const [timeline, setTimeline] = useState(null);
  // PUSH AF2 — MODEL attribution view: mutually exclusive with SHADOW (showVetos).
  // null = off; { asset, strategy, tf, regime } = viewing a model bucket from Engine Intelligence.
  const [modelView, setModelView] = useState(null);
  const [modelViewLoading, setModelViewLoading] = useState(false);
  // PUSH AC — PnL calendar granularity: DAY | WEEK (re-aggregates both charts)
  const [calGranularity, setCalGranularity] = useState('DAY');
  const [expandedReason, setExpandedReason] = useState({}); // keyed by scan_id (and sp-<id> for old shadow rows)
  const toggleReason = useCallback((key) => setExpandedReason(prev => ({ ...prev, [key]: !prev[key] })), []);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);

  // PUSH AB — dedicated refs for the timeline chart (never touch chartRef/chartContainerRef)
  const timelineContainerRef = useRef(null);
  const timelineChartRef = useRef(null);
  // 🟢 PUSH AM29 — shared-crosshair tooltip state (all series values at cursor)
  const [timelineTooltip, setTimelineTooltip] = useState(null);
  // AH2 — MODEL view: remember the last non-empty model series so a 0-trade
  // bucket does not silently blank the chart (explicit empty > silent vanish).
  const lastModelSeriesRef = useRef(null);

  useEffect(() => {
      setIsMounted(true);
  }, []);

  // Load tenant_id for row-level security filtering (mirrors index.js pattern)
  useEffect(() => {
    const loadTenantId = async () => {
      if (!session?.user?.id) return;
      try {
        const { data: users, error } = await supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('auth_user_id', session.user.id)
          .single();
        if (error) {
          console.error('[PERFORMANCE] Failed to fetch tenant_id:', error);
          return;
        }
        if (users?.tenant_id) {
          setTenantId(users.tenant_id);
        }
      } catch (err) {
        console.error('[PERFORMANCE] Failed to load tenant_id:', err);
      }
    };
    loadTenantId();
  }, [session?.user?.id, supabase]);

  // Fetch Engine Intelligence data
  useEffect(() => {
    if (!session?.access_token) return;
    let isCancelled = false;
    const fetchEngineIntel = async () => {
      setEngineIntelLoading(true);
      try {
        const res = await fetch('/api/engine-intel', {
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        if (res.ok) {
          const json = await res.json();
          if (!isCancelled) setEngineIntel(json);
        }
      } catch (err) {
        console.error('[PERFORMANCE] Failed to load engine intelligence:', err);
      } finally {
        if (!isCancelled) setEngineIntelLoading(false);
      }
    };
    fetchEngineIntel();
    return () => { isCancelled = true; };
  }, [session?.access_token]);

  // PUSH AB — Fetch Performance Timeline (30d daily PnL + Veto Ledger).
  // PUSH AF2 — when modelView is set, refetch with the bucket params for attribution.
  useEffect(() => {
    if (!session?.access_token) return;
    let isCancelled = false;
    const fetchTimeline = async () => {
      if (modelView) setModelViewLoading(true);
      try {
        const params = new URLSearchParams({ days: '30' });
        if (modelView) {
          if (modelView.asset) params.set('asset', modelView.asset);
          if (modelView.strategy) params.set('strategy', modelView.strategy);
          if (modelView.tf) params.set('tf', modelView.tf);
          if (modelView.regime) params.set('regime', modelView.regime);
        }
        const res = await fetch(`/api/performance/timeline?${params.toString()}`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        if (res.ok) {
          const json = await res.json();
          if (!isCancelled) setTimeline(json);
        }
      } catch (err) {
        console.error('[PERFORMANCE] Failed to load performance timeline:', err);
        // On failure render nothing for the new sections — page must never break.
      } finally {
        if (!isCancelled) setModelViewLoading(false);
      }
    };
    fetchTimeline();
    return () => { isCancelled = true; };
  }, [session?.access_token, modelView]);

  // Helper: format a Date as a local YYYY-MM-DD (avoids UTC off-by-one issues).
  // Declared BEFORE every memo that calls it (TDZ — plain const, not hoisted).
  const toLocalDateStr = (d) => {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
  };

  // PUSH AC — cumulative series for the timeline chart. Obeys the EXISTING controls:
  // modeFilter picks LIVE/PAPER (ALL = both); showVetos (SHADOW mode) replaces the
  // trade series with the shadow curve. WEEK granularity re-buckets into ISO weeks.
  // 🟢 PUSH AM29 — ALL-mode renders all FIVE series (MISSED/SAVED/NET/PAPER/LIVE)
  // on ONE shared axis in % of entry; the dual-axis $ overlay is gone.
  const timelineSeries = useMemo(() => {
    if (!timeline?.cumulative) return [];
    // PUSH AF2 — MODEL attribution view: Approved (emerald $) vs Flagged (rose $)
    if (modelView) {
      // AJ1 — honest empty state: when the refetched bucket has 0 approved AND
      // 0 flagged rows, CLEAR the cached series and return [] so no stale lines
      // linger. The "0 trades match this bucket" note chip explains the empty
      // state. While modelViewLoading is true, keep rendering the previous
      // series (no empty flash mid-refetch).
      const model = [
        { key: 'modelApproved', color: '#10b981', data: timeline.cumulative.modelApproved || [] },
        { key: 'modelFlagged', color: '#f43f5e', data: timeline.cumulative.modelFlagged || [] },
      ];
      let series = calGranularity === 'WEEK' ? model.map(s => ({ ...s, data: weeklyCumulative(s.data) })) : model.filter(s => s.data.length > 0);
      if (series.length === 0) {
        if (modelViewLoading) {
          // Mid-refetch: keep the previous series on screen (no empty flash).
          if (lastModelSeriesRef.current) return lastModelSeriesRef.current;
          return [];
        }
        // Refetch complete and bucket is genuinely empty — clear the cache.
        lastModelSeriesRef.current = null;
        return [];
      }
      lastModelSeriesRef.current = series;
      return series;
    }
    if (showVetos) {
      // PUSH AF1 — SHADOW renders THREE lines in % of veto price (measured):
      // SAVED (emerald), MISSED (rose), NET (orange, bold). AM29 — config-$
      // dropped from the chart (kept in the ledger card + totals strip): $
      // can't share a % axis honestly.
      const shadow = [
        { key: 'shadowMissedPct', label: 'SHADOW MISSED', color: '#f43f5e', data: timeline.cumulative.shadowMissedPct || [] },
        { key: 'shadowSavedPct', label: 'SHADOW SAVED', color: '#10b981', data: timeline.cumulative.shadowSavedPct || [] },
        { key: 'shadowNetPct', label: 'SHADOW NET', color: '#f97316', data: timeline.cumulative.shadowNetPct || [], lineWidth: 3 },
      ];
      if (calGranularity === 'WEEK') return shadow.map(s => ({ ...s, data: weeklyCumulative(s.data) }));
      return shadow.filter(s => s.data.length > 0);
    }
    // 🟢 PUSH AM29 — ONE shared axis, % of entry everywhere. pts are asset-scaled
    // (870 pts on BIP ≠ 870 pts on SLP) and $ mixes position sizes; % of entry is
    // the only unit where shadow, paper and live share one axis honestly. PAPER/
    // LIVE are cumulative pnl/notional (sum of per-trade %, same non-compounded
    // convention as the shadow series).
    const allSeries = [
      { key: 'shadowMissedPct', label: 'SHADOW MISSED', color: '#f43f5e', data: timeline.cumulative.shadowMissedPct || [] },
      { key: 'shadowSavedPct', label: 'SHADOW SAVED', color: '#10b981', data: timeline.cumulative.shadowSavedPct || [] },
      { key: 'shadowNetPct', label: 'SHADOW NET', color: '#f97316', data: timeline.cumulative.shadowNetPct || [], lineWidth: 3 },
      { key: 'paperPct', label: 'PAPER', color: '#a78bfa', data: timeline.cumulative.paperPct || [] },
      { key: 'livePct', label: 'LIVE', color: '#3b82f6', data: timeline.cumulative.livePct || [] },
    ];
    let series = modeFilter === 'LIVE'
      ? allSeries.filter(s => s.key === 'livePct')
      : modeFilter === 'PAPER'
        ? allSeries.filter(s => s.key === 'paperPct')
        : allSeries;
    if (calGranularity === 'WEEK') series = series.map(s => ({ ...s, data: weeklyCumulative(s.data) }));
    return series.filter(s => s.data.length > 0);
  }, [timeline, modeFilter, showVetos, modelView, modelViewLoading, calGranularity]);

  // PUSH AC — vetoes grouped by LOCAL date (toLocalDateStr, same convention as the
  // calendar), desc. AH3 — the ledger defaults to NO day filter (last 30d);
  // the calendar day-filter applies only when the user explicitly clicks a day
  // (explicitDaySelected). The auto-selected "today" drives the trade log only.
  const vetoGroups = useMemo(() => {
    if (!timeline?.vetoes?.length) return [];
    const filtered = timeline.vetoes.filter(v => {
      if (!explicitDaySelected || !selectedDate) return true;
      const t = v.veto_time ? new Date(v.veto_time) : null;
      return t && !isNaN(t.getTime()) && toLocalDateStr(t) === selectedDate;
    });
    const groups = {};
    for (const v of filtered) {
      const t = v.veto_time ? new Date(v.veto_time) : null;
      if (!t || isNaN(t.getTime())) continue;
      const key = toLocalDateStr(t);
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }
    return Object.keys(groups)
      .sort((a, b) => (a < b ? 1 : -1))
      .map(date => {
        const rows = groups[date].sort((a, b) => new Date(b.veto_time) - new Date(a.veto_time));
        const net = rows.reduce((s, v) => s + (v.verdict === 'SAVED' ? (parseFloat(v.saved_amount) || 0) : v.verdict === 'MISSED' ? -(parseFloat(v.missed_amount) || 0) : 0), 0);
        return {
          date,
          rows,
          net: Math.round(net * 100) / 100,
          saved: rows.filter(v => v.verdict === 'SAVED').length,
          missed: rows.filter(v => v.verdict === 'MISSED').length,
        };
      });
  }, [timeline, selectedDate, explicitDaySelected]);

  // Build a full month grid: leading blanks for the first weekday, then each day
  // of the visible month. `null` entries render as empty cells.
  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(toLocalDateStr(new Date(year, month, day)));
    }
    return cells;
  }, [calendarMonth]);

  // The set of actual date strings in the visible month (used for daily stats).
  const calendarDays = useMemo(() => calendarCells.filter(Boolean), [calendarCells]);

  // Open positions are tracked separately so that all of the historical math
  // below (calendar, equity curve, daily stats) keeps working off CLOSED
  // trades only. Open trades surface as actionable rows at the top of the
  // Execution Logs section (Reevaluate / Close).
  const [openPositions, setOpenPositions] = useState([]);

  const fetchPerformance = useCallback(async () => {
    if (!tenantId) return; // Wait for tenant_id before querying
    setLoading(true);
    try {
      // Build queries with tenant_id filtering and explicit limit.
      // Closed trades: sort DESC so the LIMIT window captures the NEWEST
      // trades — avoids the old bug where ASC + 1000-row cap returned only
      // the oldest trades, cutting off recent days.
      let closedQuery = supabase
        .from('trade_logs')
        .select('*')
        .not('exit_price', 'is', null)
        .eq('tenant_id', tenantId)
        .order('exit_time', { ascending: false })
        .limit(5000);

      let liveQuery = supabase
        .from('trade_logs')
        .select('*')
        .is('exit_price', null)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(5000);

      const [{ data: closedTrades }, { data: liveTrades }] = await Promise.all([
        closedQuery,
        liveQuery,
      ]);

      // Relaxed filter: only drop trades with missing/invalid exit_time.
      // Zero-PnL trades (pnl===0 && entry_price===exit_price) are kept —
      // the exit-price fallback logic (execute-trade-mcp.js, watchdog.js)
      // can legitimately produce this pattern. See:
      // /memories/repo/exit-price-pnl-tracking-issues.md
      const valid = (closedTrades || []).filter(t => {
          if (!t || !t.exit_time) return false;
          if (isNaN(new Date(t.exit_time).getTime())) return false;
          return true;
      });

      setAllValidTrades(valid);
      setOpenPositions(liveTrades || []);
      // AH3 — auto-select today for the trade log, but NOT as an explicit
      // ledger filter (explicitDaySelected stays false → ledger shows last 30d).
      setSelectedDate(toLocalDateStr(new Date()));
    } catch (err) {
      console.error("Performance Fetch Error:", err);
    } finally {
      setLoading(false);
    }
  }, [supabase, tenantId]);

  useEffect(() => { 
      if (isMounted) fetchPerformance(); 
  }, [fetchPerformance, isMounted]);

  // 🆕 Fetch risk veto blocks
  useEffect(() => {
    if (!supabase || !tenantId) return;
    const fetchRiskBlocks = async () => {
      const { data } = await supabase
        .from('risk_veto_log')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (data) setRiskBlocks(data);
    };
    fetchRiskBlocks();
  }, [tenantId, supabase]);
  // 🆕 Fetch linked core memories for displayed trades
  // � Fetch linked core memories for displayed trades
  useEffect(() => {
    if (!supabase || !allValidTrades.length || !tenantId) return;
    const fetchLinkedMemories = async () => {
      const map = {};
      const allMemoryIds = new Set();
      const allTradeIds = new Set();
      allValidTrades.forEach(t => {
        if (t.id) allTradeIds.add(t.id);
        if (t.influencing_memory_ids?.length) {
          t.influencing_memory_ids.forEach(id => allMemoryIds.add(id));
        }
      });
      if (allMemoryIds.size > 0) {
        const ids = [...allMemoryIds];
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const { data } = await supabase.from('hermes_core_memory').select('*').in('id', chunk).limit(50);
          if (data) data.forEach(m => { map[m.id] = m; });
        }
      }
      if (allTradeIds.size > 0) {
        const ids = [...allTradeIds];
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const { data } = await supabase.from('hermes_core_memory').select('*').in('trade_log_id', chunk).limit(50);
          if (data) data.forEach(m => { map[m.id] = m; });
        }
      }
      setLinkedMemories(map);

      // 🟢 Agent Tool Calls: fetch and match hierarchically (trade_id -> trade lifetime window)
      try {
        const { data: tcData, error: tcErr } = await supabase
          .from('agent_tool_calls')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(500);

        if (tcErr) {
          console.warn('[PERFORMANCE] Tool calls fetch error:', tcErr.message);
        }

        const toolCallsMapAccum = {};
        const combinedTrades = [...allValidTrades, ...openPositions];

        (tcData || []).forEach(tc => {
          const tcTime = new Date(tc.created_at).getTime();
          const matches = [];
          
          // 1. Direct trade_id match
          if (tc.trade_id) {
            const direct = combinedTrades.find(tr => String(tr.id) === String(tc.trade_id));
            if (direct) matches.push(direct);
          }

          // 2. Direct scan_id match
          if (tc.scan_id) {
            const scanMatch = combinedTrades.find(tr => String(tr.scan_id) === String(tc.scan_id));
            if (scanMatch && !matches.includes(scanMatch)) matches.push(scanMatch);
          }

          // 3. Reverse trade correlation ([REVERSE_OPEN] or [REVERSE_CLOSE])
          combinedTrades.forEach(tr => {
            if (matches.includes(tr)) return;
            const isReverse = tr.reason?.includes('[REVERSE_OPEN]') || tr.reason?.includes('[REVERSE_CLOSE]');
            if (isReverse) {
              const entryTime = new Date(tr.created_at || tr.exit_time).getTime();
              const diff = Math.abs(entryTime - tcTime);
              let symbolMatches = false;
              if (tc.params_snapshot) {
                try {
                  const params = typeof tc.params_snapshot === 'string' ? JSON.parse(tc.params_snapshot) : tc.params_snapshot;
                  symbolMatches = params?.symbol === tr.symbol;
                } catch (e) {}
              }
              if (diff < 180000 && (symbolMatches || !tc.params_snapshot)) {
                matches.push(tr);
              }
            }
          });

          // 4. Asset & Lifetime / Inception window match (within 5 minutes of trade entry)
          if (matches.length === 0) {
            const windowMatch = combinedTrades.find(tr => {
              const entryTime = new Date(tr.created_at || tr.exit_time).getTime();
              const exitTime = tr.exit_time ? new Date(tr.exit_time).getTime() : Date.now();
              const timeMatches = tcTime >= entryTime - 300000 && tcTime <= exitTime + 60000;
              
              let symbolMatches = true;
              if (tc.params_snapshot) {
                try {
                  const params = typeof tc.params_snapshot === 'string' ? JSON.parse(tc.params_snapshot) : tc.params_snapshot;
                  if (params?.symbol) symbolMatches = params.symbol === tr.symbol;
                } catch (e) {}
              }
              return timeMatches && symbolMatches;
            });
            if (windowMatch) matches.push(windowMatch);
          }

          matches.forEach(tr => {
            if (!toolCallsMapAccum[tr.id]) toolCallsMapAccum[tr.id] = [];
            const list = toolCallsMapAccum[tr.id];
            const insertIdx = list.findIndex(existing => new Date(tc.created_at) < new Date(existing.created_at));
            if (insertIdx === -1) list.push(tc); else list.splice(insertIdx, 0, tc);
          });
        });

        setToolCallsMap(toolCallsMapAccum);
      } catch (err) {
        console.error('[PERFORMANCE] Tool calls fetch failed:', err.message);
      }
    };
    fetchLinkedMemories();
  }, [allValidTrades, openPositions, tenantId, supabase]);

  // 🆕 Force-review an open trade through the Oracle. Mirrors handler in pages/audit.js
  // so the user can act from the Performance view without context-switching.
  const handleForceReview = useCallback(async (tradeId) => {
    if (!session?.access_token || !tradeId) return;
    setReviewingId(tradeId);
    try {
      const res = await fetch('/api/reevaluate-trade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ trade_id: tradeId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Review failed (${res.status})`);
      alert(`Oracle Verdict: ${data.status}\n\n${data.reasoning || ''}`);
      fetchPerformance();
    } catch (err) {
      alert(`Review Failed: ${err.message}`);
    } finally {
      setReviewingId(null);
    }
  }, [session, fetchPerformance]);

  // 🛑 Force-close an open trade. Same payload shape as pages/audit.js handleClosePosition.
  const handleClosePosition = useCallback(async (trade) => {
    if (!session?.access_token || !trade) return;
    const ok = window.confirm(`Cancel/close the active setup for ${trade.symbol}?`);
    if (!ok) return;
    setClosingId(trade.id);
    try {
      const closingSide = (trade.side === 'BUY' || trade.side === 'LONG') ? 'SELL' : 'BUY';
      const res = await fetch('/api/close-position', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          side: closingSide,
          qty: trade.qty,
          price: 0
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Close failed (${res.status})`);
      fetchPerformance();
    } catch (e) {
      alert(`Cancel Failed: ${e.message}`);
    } finally {
      setClosingId(null);
    }
  }, [session, fetchPerformance]);

  // Normalize a trade's execution mode to 'LIVE' or 'PAPER'. Defaults to PAPER
  // (simulated) when no explicit mode is recorded — the safe assumption.
  const tradeMode = (t) => {
      const raw = (t.execution_mode || t.mode || '').toString().toUpperCase();
      return raw === 'LIVE' ? 'LIVE' : 'PAPER';
  };

  const globalFilteredTrades = useMemo(() => {
      return allValidTrades.filter(t => {
          if (assetFilter !== 'ALL' && t.symbol !== assetFilter) return false;
          if (strategyFilter !== 'ALL' && t.strategy_id !== strategyFilter) return false;
          if (modeFilter !== 'ALL' && tradeMode(t) !== modeFilter) return false;
          return true;
      });
  }, [allValidTrades, assetFilter, strategyFilter, modeFilter]);

  const chartData = useMemo(() => {
      const data = [];
      let cumulativePnl = 0;
      let lastTime = 0;

      // Sort ascending for cumulative equity curve (data is already in-memory
      // from a DESC query, so re-sort here for the chart series).
      const sortedTrades = [...globalFilteredTrades].sort((a, b) => new Date(a.exit_time).getTime() - new Date(b.exit_time).getTime());

      sortedTrades.forEach(t => {
          let safeTime = Math.floor(new Date(t.exit_time).getTime() / 1000);
          if (safeTime <= lastTime) safeTime = lastTime + 1; 
          lastTime = safeTime;
          
          const pnlNum = parseFloat(t.pnl) || 0;
          cumulativePnl += pnlNum;
          data.push({ time: safeTime, value: parseFloat(cumulativePnl.toFixed(2)) });
      });

      // PUSH AC — WEEK granularity: group trades by exit ISO-week (label = week
      // start date); per-trade points collapse to the week's closing cumulative.
      if (calGranularity === 'WEEK') {
        const byWeek = new Map();
        for (const pt of data) {
          const d = new Date(pt.time * 1000);
          const wsKey = localDateStr(isoWeekStart(d));
          byWeek.set(wsKey, pt.value);
        }
        return [...byWeek.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([k, value]) => ({ time: Math.floor(new Date(`${k}T00:00:00`).getTime() / 1000), value }));
      }
      return data;
  }, [globalFilteredTrades, calGranularity]);

  const dailyStats = useMemo(() => {
      const stats = {};
      calendarDays.forEach(day => stats[day] = { pnl: 0, trades: 0 });
      
      globalFilteredTrades.forEach(t => {
          const dateStr = toLocalDateStr(new Date(t.exit_time));
          if (stats[dateStr]) {
              stats[dateStr].pnl += (parseFloat(t.pnl) || 0);
              stats[dateStr].trades += 1;
          }
      });
      return stats;
  }, [globalFilteredTrades, calendarDays]);

  useEffect(() => {
    if (!isMounted || !chartContainerRef.current || chartData.length === 0) return;
    
    if (chartRef.current) {
        try { chartRef.current.remove(); } catch(e){}
        chartRef.current = null;
    }

    const chart = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth || 800,
        height: chartContainerRef.current.clientHeight || 300,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.1)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    });

    // 🟢 THE FIX: Use V5 syntax for adding AreaSeries
    const series = chart.addSeries(AreaSeries, {
        lineColor: '#3b82f6',
        topColor: 'rgba(59, 130, 246, 0.4)',
        bottomColor: 'rgba(59, 130, 246, 0.0)',
        lineWidth: 2,
    });

    series.setData(chartData);
    chart.timeScale().fitContent();
    chartRef.current = chart;

    const handleResize = () => {
        if(chartContainerRef.current && chartRef.current) {
            chartRef.current.applyOptions({ 
                width: chartContainerRef.current.clientWidth || 800, 
                height: chartContainerRef.current.clientHeight || 300 
            });
        }
    };
    
    window.addEventListener('resize', handleResize);

    return () => {
        window.removeEventListener('resize', handleResize);
        if (chartRef.current) {
            try { chartRef.current.remove(); } catch (e) {}
            chartRef.current = null;
        }
    };
  }, [chartData, isMounted]);

  // PUSH AC — timeline day-key formatter. WEEK granularity → ISO-week start label.
  // Declared BEFORE the chart useEffect below (its dep array references this).
  const timelineTimeFormatter = useCallback((time) => {
    if (calGranularity === 'WEEK') {
      const ws = isoWeekStart(new Date(`${time}T00:00:00`));
      return toLocalDateStr(ws);
    }
    return time;
  }, [calGranularity]);

  // PUSH AB — build the timeline chart (own container; same dark options as the equity chart)
  useEffect(() => {
    if (!isMounted || !timelineContainerRef.current || timelineSeries.length === 0) return;

    if (timelineChartRef.current) {
      try { timelineChartRef.current.remove(); } catch (e) {}
      timelineChartRef.current = null;
    }

    const chart = createChart(timelineContainerRef.current, {
      width: timelineContainerRef.current.clientWidth || 800,
      height: timelineContainerRef.current.clientHeight || 300,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      timeScale: {
        timeVisible: false,
        borderColor: 'rgba(255,255,255,0.1)',
        // PUSH AC — WEEK granularity: tick labels show the ISO-week start date.
        tickMarkFormatter: timelineTimeFormatter,
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    });

    for (const s of timelineSeries) {
      const series = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.lineWidth || 2, // PUSH AF1/AM29 — NET line is bold (3)
        lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
        // 🟢 PUSH AM29 — single shared axis: every series binds the default right
        // scale (% of entry unit). Dual-axis structure removed entirely.
        priceLineVisible: false,
        lastValueVisible: true,
      });
      series.setData(s.data);
    }
    chart.timeScale().fitContent();
    timelineChartRef.current = chart;

    // 🟢 PUSH AM29 — shared-crosshair tooltip: one date + ALL series values at cursor.
    // param.time can be a string, a BusinessDay object, or a UTCTimestamp depending
    // on library internals — normalize to 'YYYY-MM-DD' before lookup + formatting.
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point) {
        setTimelineTooltip(null);
        return;
      }
      const t = param.time;
      let timeStr = null;
      if (typeof t === 'string') timeStr = t;
      else if (t && typeof t === 'object' && typeof t.year === 'number') {
        timeStr = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
      } else if (typeof t === 'number' && isFinite(t)) {
        timeStr = new Date(t * 1000).toISOString().slice(0, 10);
      }
      if (!timeStr) {
        setTimelineTooltip(null);
        return;
      }
      const rows = timelineSeries.map(s => {
        const pt = (s.data || []).find(p => p.time === timeStr);
        return { label: s.label || s.key, color: s.color, value: pt ? pt.value : null };
      });
      setTimelineTooltip({ x: param.point.x, y: param.point.y, time: timelineTimeFormatter(timeStr), rows });
    });

    const handleResize = () => {
      if (timelineContainerRef.current && timelineChartRef.current) {
        timelineChartRef.current.applyOptions({
          width: timelineContainerRef.current.clientWidth || 800,
          height: timelineContainerRef.current.clientHeight || 260,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      setTimelineTooltip(null); // AM29 — no stale tooltip once the chart is torn down
      if (timelineChartRef.current) {
        try { timelineChartRef.current.remove(); } catch (e) {}
        timelineChartRef.current = null;
      }
    };
  }, [timelineSeries, isMounted, timelineTimeFormatter, calGranularity]);

  const displayLogs = useMemo(() => {
      const reversed = [...globalFilteredTrades].reverse(); 
      return reversed.filter(t => {
          const dateStr = toLocalDateStr(new Date(t.exit_time));
          if (selectedDate && dateStr !== selectedDate) return false;

          const pnl = parseFloat(t.pnl) || 0;
          if (logFilter === 'WIN') return pnl > 0;
          if (logFilter === 'LOSS') return pnl <= 0;
          if (logFilter === 'LONG') return t.side === 'BUY' || t.side === 'LONG';
          if (logFilter === 'SHORT') return t.side === 'SELL' || t.side === 'SHORT';
          return true;
      }).map(t => {
          const originalReason = typeof t.reason === 'string' ? t.reason.split('[EXIT TRIGGER]:')[0].trim() : '';
          return {
              dateStr: toLocalDateStr(new Date(t.exit_time)),
              timeStr: new Date(t.exit_time).toLocaleTimeString(),
              asset: t.symbol || 'UNKNOWN',
              strategy: t.strategy_id || 'UNKNOWN',
              trade: t,
              reasoning: originalReason
          };
      });
  }, [globalFilteredTrades, selectedDate, logFilter]);

  const generateInsights = () => {
      if (globalFilteredTrades.length < 5) return "Accumulating telemetry. Minimum 5 trades required to generate reliable optimization insights.";
      
      const wins = globalFilteredTrades.filter(t => (parseFloat(t.pnl) || 0) > 0);
      const losses = globalFilteredTrades.filter(t => (parseFloat(t.pnl) || 0) <= 0);
      
      const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0) / losses.length) : 0;
      
      const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'Infinity';
      const globalWinRate = globalFilteredTrades.length > 0 ? ((wins.length / globalFilteredTrades.length) * 100).toFixed(1) : '0.0';

      if (profitFactor !== 'Infinity' && parseFloat(profitFactor) < 1.0 && parseFloat(globalWinRate) > 50) {
          return `Negative Skew Detected: Win rate is healthy (${globalWinRate}%), but Average Loss ($${avgLoss.toFixed(2)}) exceeds Average Win ($${avgWin.toFixed(2)}). Consider tightening your SL Tripwire or trailing stops faster to preserve capital.`;
      } else if (parseFloat(globalWinRate) < 40 && profitFactor !== 'Infinity' && parseFloat(profitFactor) > 1.5) {
          return `Low Strike Rate / High Reward: You are getting stopped out frequently (${globalWinRate}% Win Rate), but when you win, you win big (PF: ${profitFactor}). Consider widening your initial Stop Loss to avoid liquidity wicks.`;
      } else if (profitFactor !== 'Infinity' && parseFloat(profitFactor) > 1.5 && parseFloat(globalWinRate) >= 50) {
          return `Optimal Structure Maintained: System is highly profitable with a Profit Factor of ${profitFactor}. Maintain current tripwire settings. Consider scaling up base contract sizes dynamically.`;
      } else {
          return `System Stable: Win Rate is ${globalWinRate}% with an Average Win of $${avgWin.toFixed(2)}. Monitor market regimes before adjusting tripwires.`;
      }
  };

  const dailyLogs = globalFilteredTrades.filter(t => toLocalDateStr(new Date(t.exit_time)) === selectedDate);
  const dailyPnl = dailyLogs.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
  const dailyWins = dailyLogs.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
  const dailyLosses = dailyLogs.filter(t => (parseFloat(t.pnl) || 0) <= 0).length;
  const dailyWinRate = dailyLogs.length > 0 ? ((dailyWins / dailyLogs.length) * 100).toFixed(1) : 0;

  const uniqueAssets = [...new Set(allValidTrades.map(t => t.symbol).filter(Boolean))];
  const uniqueStrategies = [...new Set(allValidTrades.map(t => t.strategy_id).filter(Boolean))];

  if (!isMounted) return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center text-indigo-500 font-mono tracking-widest uppercase">
       <BarChart3 className="animate-pulse mb-4" size={32} />
       Syncing Telemetry...
    </div>
  );

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-3 md:p-6 font-sans flex flex-col gap-6 max-w-[100vw] overflow-x-hidden">
      
      <header className="max-w-7xl w-full mx-auto flex flex-col lg:flex-row justify-between items-center pb-4 border-b border-white/10 gap-4">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <div className="p-2 md:p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
            <BarChart3 className="text-emerald-400" size={20} md={24} />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-black italic tracking-tighter bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent uppercase text-left">Performance Analytics</h1>
            <p className="text-[8px] md:text-[10px] text-slate-500 font-mono uppercase tracking-widest mt-1">Daily ROI & Execution Ledger</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 md:gap-4 bg-slate-900/50 p-2 rounded-2xl border border-white/5 w-full lg:w-auto justify-between">
            <div className="flex items-center gap-2 px-3">
                <Layers size={14} className="text-slate-400" />
                <select 
                    className="bg-transparent text-[10px] font-black uppercase tracking-widest text-cyan-300 focus:outline-none cursor-pointer" 
                    value={assetFilter} 
                    onChange={(e) => setAssetFilter(e.target.value)}
                >
                    <option value="ALL">All Assets</option>
                    {uniqueAssets.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
            </div>
            <div className="flex items-center gap-2 px-3 border-l border-white/10">
                <select 
                    className="bg-transparent text-[10px] font-black uppercase tracking-widest text-indigo-300 focus:outline-none cursor-pointer max-w-[150px] truncate" 
                    value={strategyFilter} 
                    onChange={(e) => setStrategyFilter(e.target.value)}
                >
                    <option value="ALL">All Strategies</option>
                    {uniqueStrategies.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>
            {/* LIVE vs PAPER segmented control */}
            <div className="flex items-center gap-1 px-2 border-l border-white/10">
                {['ALL', 'LIVE', 'PAPER'].map(m => (
                    <button
                        key={m}
                        onClick={() => setModeFilter(m)}
                        className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all ${
                            modeFilter === m
                                ? (m === 'LIVE' ? 'bg-red-500/20 border-red-500/50 text-red-300'
                                   : m === 'PAPER' ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                                   : 'bg-slate-700/40 border-white/20 text-white')
                                : 'border-white/5 text-slate-500 hover:bg-white/5'
                        }`}
                    >
                        {m}
                    </button>
                ))}
                <button
                  onClick={() => setShowRiskBlocks(!showRiskBlocks)}
                  className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all ${
                    showRiskBlocks ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'border-white/5 text-slate-500 hover:bg-white/5'
                  }`}
                >
                  🚫 Risk Blocks ({riskBlocks.length})
                </button>
            </div>
        </div>
      </header>

      <div className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-slate-900/40 border border-white/10 rounded-3xl p-4 md:p-6 shadow-2xl flex flex-col min-h-[300px]">
              <h3 className="text-[9px] md:text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center justify-between">
                  <span className="flex items-center gap-2"><LineChart size={14}/> Cumulative Equity Curve</span>
                  {chartData.length > 0 && <span className={`text-xs font-mono font-bold ${chartData[chartData.length-1].value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${chartData[chartData.length-1].value.toFixed(2)}</span>}
              </h3>
              {chartData.length > 0 ? (
                  <div ref={chartContainerRef} className="flex-grow w-full relative min-h-[200px] md:min-h-[250px]" style={{ height: '300px' }} />
              ) : (
                  <div className="flex-grow flex items-center justify-center text-slate-600 font-mono text-[9px] md:text-[10px] uppercase tracking-widest">No valid trades to plot</div>
              )}
          </div>
          
          <div className="lg:col-span-1 bg-indigo-500/10 border border-indigo-500/20 rounded-3xl p-4 md:p-6 shadow-2xl flex flex-col gap-4">
             <h3 className="text-[9px] md:text-[10px] font-black uppercase text-indigo-300 tracking-widest flex items-center gap-2"><Lightbulb size={14}/> Optimizer Insights</h3>
             <p className="text-[11px] md:text-[12px] text-indigo-200 leading-relaxed font-mono italic">
                 {generateInsights()}
             </p>
             <div className="mt-auto pt-4 border-t border-indigo-500/20">
                 <div className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Filtered Trades Evaluated: <span className="text-white">{globalFilteredTrades.length}</span></div>
             </div>
          </div>
      </div>

      {/* ⚙️ Engine Intelligence Section */}
      <div className="max-w-7xl w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-4 md:p-6 shadow-2xl flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-indigo-400" />
            <h3 className="text-xs md:text-sm font-black uppercase text-white tracking-widest">⚙️ Engine Intelligence</h3>
          </div>

          {/* Health Status Chips */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Trainer Status Chip */}
            <div className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wider flex items-center gap-1.5 border ${
              engineIntel?.engineHealth?.trainerStatus === 'OK'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : engineIntel?.engineHealth?.trainerStatus === 'STALE'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : 'bg-slate-800 border-white/5 text-slate-400'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                engineIntel?.engineHealth?.trainerStatus === 'OK' ? 'bg-emerald-400' : 'bg-amber-400'
              }`} />
              Trainer {engineIntel?.engineHealth?.trainerStatus || 'LOADING'}
            </div>

            {/* Shadow Portfolio Chip */}
            <div className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-slate-800/60 border border-white/10 text-slate-300 flex items-center gap-1.5">
              <span>Shadow:</span>
              <span className="text-emerald-400 font-mono">{engineIntel?.engineHealth?.shadow?.SAVED ?? 0} saved</span>
              <span className="text-slate-600">·</span>
              <span className="text-rose-400 font-mono">{engineIntel?.engineHealth?.shadow?.MISSED ?? 0} missed</span>
            </div>

            {/* Archetypes Chip */}
            <div className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center gap-1">
              <Layers className="w-3 h-3" /> Archetypes: <span className="font-mono text-white ml-0.5">{engineIntel?.engineHealth?.archetypesCount ?? 0}</span>
            </div>
          </div>
        </div>

        {engineIntelLoading ? (
          <div className="py-8 flex items-center justify-center text-slate-500 text-xs font-mono animate-pulse">
            Loading Engine Intelligence...
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Calibration Bins & Brier Score */}
            <div className="bg-black/30 border border-white/5 rounded-2xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Model Calibration (Predicted vs Realized)</span>
                  <span className="text-[10px] font-mono text-slate-400">
                    Brier: <span className="text-white font-bold">{engineIntel?.calibration?.brierScore !== null && engineIntel?.calibration?.brierScore !== undefined ? engineIntel.calibration.brierScore : '--'}</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {(engineIntel?.calibration?.buckets || []).map((b, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-400">{b.range} (n={b.n})</span>
                        <span className={b.n > 0 ? (b.realizedWR >= 0.5 ? 'text-emerald-400 font-bold' : 'text-slate-300') : 'text-slate-600'}>
                          {b.n > 0 ? `${(b.realizedWR * 100).toFixed(1)}% WR` : 'No samples'}
                        </span>
                      </div>
                      <div className="h-2 w-full bg-slate-950 rounded-full overflow-hidden border border-white/5">
                        <div
                          className="h-full bg-indigo-500 rounded-full transition-all"
                          style={{ width: `${Math.min(100, Math.max(0, (b.realizedWR || 0) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-white/5 text-[9px] text-slate-500">
                Total evaluated closed trades with model predictions: {engineIntel?.calibration?.totalEvaluated ?? 0}
              </div>
            </div>

            {/* Priors Table */}
            <div className="bg-black/30 border border-white/5 rounded-2xl p-4 flex flex-col">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Learned Model Priors</span>
              <div className="overflow-x-auto max-h-[220px] overflow-y-auto">
                <table className="w-full text-left text-[10px] font-mono border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-500 uppercase text-[8px] font-black tracking-wider">
                      <th className="pb-2">Asset / Regime</th>
                      <th className="pb-2">Strategy</th>
                      <th className="pb-2 text-center">N</th>
                      <th className="pb-2 text-right">Win Rate</th>
                      <th className="pb-2 text-right">Exp PnL</th>
                      <th className="pb-2 text-right">Capture</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    {!engineIntel?.priors || engineIntel.priors.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-600 italic">No calibration priors available</td>
                      </tr>
                    ) : (
                      engineIntel.priors.map((p, idx) => (
                        <tr key={idx} className="hover:bg-white/[0.02]">
                          <td className="py-2 text-white font-bold">{p.asset} <span className="text-slate-500 font-normal">({p.regime})</span></td>
                          <td className="py-2 text-slate-400">{p.strategy}</td>
                          <td className="py-2 text-center">
                            {p.n}
                            {/* PUSH AF2 — low n warning chip */}
                            {p.n < 20 && <span className="ml-1 px-1 rounded text-[7px] bg-amber-500/20 text-amber-300" title="low sample count">low n</span>}
                          </td>
                          <td className="py-2 text-right text-emerald-400 font-bold">{p.win_rate !== null ? `${(p.win_rate * 100).toFixed(0)}%` : '--'}</td>
                          <td className="py-2 text-right">{p.expected_pnl_mean !== null ? `$${p.expected_pnl_mean.toFixed(2)}` : '--'}</td>
                          <td className="py-2 text-right flex items-center justify-end gap-1">
                            {p.capture_ratio !== null ? `${(p.capture_ratio * 100).toFixed(0)}%` : '--'}
                            {/* PUSH AF2 — view PnL: switches timeline to MODEL attribution for this bucket */}
                            <button
                              onClick={() => setModelView({ asset: p.asset, strategy: p.strategy, tf: null, regime: p.regime })}
                              className="px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-wider bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
                              title="View PnL attribution for this model bucket"
                            >
                              view PnL
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ⏱️ Performance Timeline (PUSH AB) — AH2: relocated below Engine Intelligence */}
      {timeline && (
        <div className="max-w-7xl w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-4 md:p-6 shadow-2xl flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-[9px] md:text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
              <Clock size={14}/> Performance Timeline
              {showVetos && <span className="px-2 py-0.5 rounded-full text-[8px] bg-orange-500/20 text-orange-300">SHADOW</span>}
              {modelView && (
                <span className="px-2 py-0.5 rounded-full text-[8px] bg-emerald-500/20 text-emerald-300 flex items-center gap-1">
                  MODEL {modelView.asset || 'ALL'}
                  <button onClick={() => setModelView(null)} className="hover:text-white">✕</button>
                </span>
              )}
              {/* AH2 — explicit empty-bucket note: 0 approved/flagged rows must not
                  silently blank the chart; previous lines stay + this chip explains. */}
              {modelView && !modelViewLoading && (timeline.totals?.model_approved_count ?? 0) === 0 && (timeline.totals?.model_flagged_count ?? 0) === 0 && (
                <span className="px-2 py-0.5 rounded-full text-[8px] bg-amber-500/20 text-amber-300">0 trades match this bucket</span>
              )}
            </h3>
            {/* PUSH AC — timeline obeys the existing LIVE/PAPER controls; SHADOW badge shows in shadow mode */}
            <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500">
              {modelView
                ? (modelViewLoading ? 'loading model bucket…' : 'model attribution ($ — real trades)')
                : showVetos
                  ? 'shadow curve (% of veto price — measured)'
                  : modeFilter === 'LIVE' ? 'live — % of entry' : modeFilter === 'PAPER' ? 'paper — % of entry' : 'all five series — % of entry (shared axis)'}
            </div>
          </div>

          {timelineSeries.length > 0 ? (
            <div className="relative">
              {/* 🟢 PUSH AM29 — single legend for the shared-axis chart */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 px-1 text-[8px] md:text-[9px] font-black uppercase tracking-widest font-mono">
                {timelineSeries.map(s => (
                  <span key={s.key} className="flex items-center gap-1.5" style={{ color: s.color }}>
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label || s.key}
                  </span>
                ))}
              </div>
              <div ref={timelineContainerRef} className="w-full min-h-[220px]" style={{ height: '300px' }} />
              {/* 🟢 PUSH AM29 — shared-crosshair tooltip (all series at cursor; gaps render as —) */}
              {timelineTooltip && (
                <div
                  className="absolute z-10 pointer-events-none bg-slate-900/95 border border-white/10 rounded-lg px-3 py-2 shadow-xl"
                  style={{
                    left: Math.min(timelineTooltip.x + 14, (timelineContainerRef.current?.clientWidth || 600) - 170),
                    top: timelineTooltip.y + 30,
                  }}
                >
                  <div className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1">{timelineTooltip.time}</div>
                  {timelineTooltip.rows.map(r => (
                    <div key={r.label} className="flex items-center gap-2 text-[9px] font-mono leading-relaxed">
                      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: r.color }} />
                      <span className="text-slate-400" style={{ width: 96 }}>{r.label}</span>
                      <span style={{ color: r.color }}>{r.value === null ? '—' : `${r.value >= 0 ? '+' : '−'}${Math.abs(r.value).toFixed(2)}%`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center text-slate-600 font-mono text-[9px] md:text-[10px] uppercase tracking-widest" style={{ height: '300px' }}>
              {modelView ? 'no model-scored trades in window' : 'No timeline data in window'}
            </div>
          )}

          {/* Totals strip — shadow amounts are price POINTS, never $.
              PUSH AF1 — SHADOW section shows % of veto price (measured); PUSH AF2 — MODEL section shows $ attribution. */}
          <div className="mt-4 pt-3 border-t border-white/5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[9px] md:text-[10px] font-black uppercase tracking-widest font-mono">
            <span className="text-blue-400">LIVE ${Number(timeline.totals?.live_pnl || 0).toFixed(2)} <span className="text-slate-600">({timeline.totals?.live_count ?? 0})</span></span>
            <span className="text-violet-400">PAPER ${Number(timeline.totals?.paper_pnl || 0).toFixed(2)} <span className="text-slate-600">({timeline.totals?.paper_count ?? 0})</span></span>
            {modelView ? (
              <span className="text-emerald-400">
                MODEL approved ${Number(timeline.totals?.model_approved_pnl || 0).toFixed(2)} <span className="text-slate-600">({timeline.totals?.model_approved_count ?? 0})</span>
                <span className="text-rose-400"> · flagged ${Number(timeline.totals?.model_flagged_pnl || 0).toFixed(2)} <span className="text-slate-600">({timeline.totals?.model_flagged_count ?? 0})</span></span>
              </span>
            ) : (
              <span className="text-orange-400">
                SHADOW {Number(timeline.totals?.shadow_net_pct || 0) >= 0 ? '+' : '−'}{Math.abs(Number(timeline.totals?.shadow_net_pct || 0)).toFixed(2)}% net
                <span className="text-emerald-400"> · saved {Number(timeline.totals?.shadow_saved_pct || 0) >= 0 ? '+' : '−'}{Math.abs(Number(timeline.totals?.shadow_saved_pct || 0)).toFixed(2)}%</span>
                <span className="text-rose-400"> · missed −{Math.abs(Number(timeline.totals?.shadow_missed_pct || 0)).toFixed(2)}%</span>
                <span className="text-slate-500"> (% of veto price — measured, over {timeline.totals?.veto_total ?? 0} vetoes)</span>
              </span>
            )}
            {!modelView && Number.isFinite(Number(timeline.totals?.shadow_net_usd)) && (
              <span className="text-slate-400">
                config-$ {Number(timeline.totals.shadow_net_usd) >= 0 ? '+' : '−'}${Math.abs(Number(timeline.totals.shadow_net_usd)).toFixed(2)} net
                <span className="text-slate-600"> (config-true sim)</span>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="max-w-7xl w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-4 md:p-6 shadow-2xl overflow-x-auto">
        <div className="flex items-center justify-between mb-4">
            <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
                <Calendar size={14}/> PnL Calendar
                {modeFilter !== 'ALL' && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-[8px] ${modeFilter === 'LIVE' ? 'bg-red-500/20 text-red-300' : 'bg-cyan-500/20 text-cyan-300'}`}>{modeFilter}</span>
                )}
            </h3>
            <div className="flex items-center gap-2">
                {/* PUSH AC — DAY | WEEK granularity: re-aggregates equity curve + timeline */}
                <div className="flex items-center gap-1 mr-1">
                    {['DAY', 'WEEK'].map(g => (
                        <button
                            key={g}
                            onClick={() => setCalGranularity(g)}
                            className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all ${
                                calGranularity === g ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'
                            }`}
                        >{g}</button>
                    ))}
                </div>
                <button
                    onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                    className="px-2 py-1 rounded-lg border border-white/10 text-slate-400 hover:bg-white/5 text-xs"
                    aria-label="Previous month"
                >‹</button>
                <span className="text-[11px] font-black uppercase tracking-widest text-slate-300 min-w-[120px] text-center">
                    {calendarMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
                </span>
                <button
                    onClick={() => setCalendarMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                    className="px-2 py-1 rounded-lg border border-white/10 text-slate-400 hover:bg-white/5 text-xs"
                    aria-label="Next month"
                >›</button>
                <button
                    onClick={() => setCalendarMonth(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })}
                    className="ml-1 px-2 py-1 rounded-lg border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10 text-[9px] font-black uppercase tracking-widest"
                >Today</button>
            </div>
        </div>

        <div className="grid grid-cols-7 gap-1.5 md:gap-2 min-w-[600px]">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(day => (
                <div key={day} className="text-center text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2">{day}</div>
            ))}
            {calendarCells.map((day, idx) => {
                if (!day) return <div key={`blank-${idx}`} className="h-16 md:h-20" />;
                const stat = dailyStats[day];
                const pnl = parseFloat(stat?.pnl || 0);
                const isSelected = selectedDate === day;
                const hasTrades = (stat?.trades || 0) > 0;
                const isToday = day === toLocalDateStr(new Date());
                
                return (
                    <button 
                        key={day} 
                        onClick={() => { setSelectedDate(day); setExplicitDaySelected(true); }}
                        className={`h-16 md:h-20 rounded-xl p-1.5 md:p-2 flex flex-col justify-between items-start transition-all border ${
                            isSelected ? 'bg-slate-800 border-indigo-500 shadow-[0_0_15px_-3px_rgba(99,102,241,0.4)]' : 
                            hasTrades ? 'bg-slate-900 border-white/5 hover:bg-slate-800' : 'bg-black/20 border-transparent opacity-60 hover:bg-white/5'
                        } ${isToday && !isSelected ? 'ring-1 ring-indigo-400/40' : ''}`}
                    >
                        <span className={`text-[10px] font-mono font-bold ${isSelected ? 'text-indigo-400' : (isToday ? 'text-indigo-300' : 'text-slate-500')}`}>{parseInt(day.split('-')[2], 10)}</span>
                        {hasTrades && (
                            <span className={`text-[10px] md:text-[12px] font-black font-mono w-full text-right ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
      </div>

      {selectedDate && (
        <div className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="bg-slate-900/40 border border-white/10 p-5 rounded-3xl">
               <div className="text-[10px] text-slate-500 font-black tracking-widest uppercase mb-4">Date: {selectedDate}</div>
               <div className={`text-3xl font-black font-mono mb-6 ${dailyPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}
               </div>
               
               <div className="space-y-3">
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><Target size={12}/> Win Rate</span>
                     <span className="font-mono text-sm">{dailyWinRate}%</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingUp size={12}/> Winners</span>
                     <span className="font-mono text-sm text-emerald-400">{dailyWins}</span>
                  </div>
                  <div className="flex justify-between items-center pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingDown size={12}/> Losers</span>
                     <span className="font-mono text-sm text-red-400">{dailyLosses}</span>
                  </div>
               </div>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-4">
             {/* Open Positions strip — actionable Reevaluate / Close buttons for
                 currently-running trades. Sits ABOVE the closed-trade history so
                 users can act on live positions without leaving this page. */}
             {openPositions.length > 0 && (
                 <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-3 space-y-2">
                     <h3 className="text-[10px] font-black uppercase tracking-widest text-emerald-300 flex items-center gap-2"><Activity size={12}/> Open Positions ({openPositions.length})</h3>
                     {openPositions.map((t) => (
                         <div key={t.id} className="flex flex-wrap items-center gap-2 sm:gap-3 bg-slate-900/40 border border-white/5 rounded-xl px-3 py-2">
                             <div className="flex-1 min-w-0">
                                 <div className="flex items-center gap-2 flex-wrap">
                                     <span className="text-[11px] font-black text-white">{t.symbol}</span>
                                     <span className={`text-[9px] font-black uppercase px-1.5 rounded ${(t.side === 'BUY' || t.side === 'LONG') ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{t.side}</span>
                                     <span className="text-[10px] font-mono text-slate-400">@ ${t.entry_price}</span>
                                     <span className="text-[9px] font-mono text-slate-500 truncate">{t.strategy_id}</span>
                                 </div>
                             </div>
                             <div className="flex gap-2 w-full sm:w-auto">
                                 <button
                                     onClick={() => handleForceReview(t.id)}
                                     disabled={reviewingId === t.id}
                                     className={`flex-1 sm:flex-none whitespace-nowrap flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${reviewingId === t.id ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50 cursor-not-allowed' : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/40'}`}
                                 >
                                     {reviewingId === t.id ? 'Analyzing…' : (<><Target size={11} /> Reevaluate</>)}
                                 </button>
                                 <button
                                     onClick={() => handleClosePosition(t)}
                                     disabled={closingId === t.id}
                                     className={`flex-1 sm:flex-none whitespace-nowrap flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${closingId === t.id ? 'bg-red-500/20 text-red-400 border border-red-500/50 cursor-not-allowed' : 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20'}`}
                                 >
                                     {closingId === t.id ? 'Closing…' : (<>Close</>)}
                                 </button>
                             </div>
                         </div>
                     ))}
                 </div>
             )}

             {/* Header row: stacks on mobile so the CSV button is never clipped. */}
             <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pl-2">
                 <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Clock size={14}/> Execution Logs</h3>
                 <div className="flex flex-wrap gap-1.5 sm:gap-2 items-center">
                     {/* AH2 — LOGS / SHADOW LEDGER are INDEPENDENT toggle chips
                         (both can be active; default BOTH on). showVetos stays
                         the source of truth for the timeline chart series. */}
                     <div className="flex items-center gap-1">
                         <button
                            onClick={() => setShowLogs(prev => !prev)}
                            className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all ${
                                showLogs ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'
                            }`}
                         >Execution Logs</button>
                         <button
                            onClick={() => setShowShadowLedger(prev => !prev)}
                            className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all ${
                                showShadowLedger ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'
                            }`}
                         >🛡️ SHADOW LEDGER ({timeline?.totals?.veto_total ?? 0})</button>
                     </div>
                     {!showLogs && ['ALL', 'WIN', 'LOSS', 'LONG', 'SHORT'].map(f => (
                         <button
                            key={f}
                            onClick={() => setLogFilter(f)}
                            className={`text-[9px] font-black uppercase tracking-widest px-2 sm:px-3 py-1 rounded-lg border whitespace-nowrap ${logFilter === f ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}
                         >
                            {f}
                         </button>
                     ))}
                     <button
                        onClick={() => {
                            const rows = [['Date','Time','Asset','Strategy','Side','Entry','Exit','PnL','Mode','Memories','Reason']];
                            displayLogs.forEach(p => {
                                const t = p.trade;
                                if (!t) return;
                                rows.push([
                                    p.dateStr, p.timeStr, p.asset, p.strategy,
                                    t.side || '', t.entry_price || '', t.exit_price || '',
                                    t.pnl || '0', t.execution_mode || '',
                                    (t.influencing_memory_ids || []).join(';'),
                                    p.reasoning || ''
                                ]);
                            });
                            const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
                            const blob = new Blob([csv], { type: 'text/csv' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `nexus-trades-${selectedDate || 'all'}.csv`;
                            a.click();
                            URL.revokeObjectURL(url);
                        }}
                        className="text-[9px] font-black uppercase tracking-widest px-2 sm:px-3 py-1 rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 whitespace-nowrap flex-shrink-0"
                     >
                        Export CSV
                     </button>
                 </div>
             </div>
             
             {/* Trade log rows when the LOGS chip is on; the SHADOW LEDGER block
                 renders below when its chip is on (both on = stacked). */}
             {showLogs && displayLogs.map((pipeline, i) => {
                const t = pipeline.trade;
                if (!t) return null;
                const pnl = parseFloat(t.pnl || 0);
                const isWin = pnl > 0;

                return (
                  <div key={i} className={`p-4 rounded-2xl border transition-all duration-300 bg-slate-900/60 ${isWin ? 'border-emerald-500/20 shadow-[0_0_20px_-10px_rgba(52,211,153,0.1)]' : 'border-red-500/20 shadow-[0_0_20px_-10px_rgba(248,113,113,0.1)]'}`}>
                     <div className="flex justify-between items-center mb-3 border-b border-white/5 pb-3">
                        <div className="flex items-center gap-4">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest ${isWin ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                              {isWin ? 'PROFIT' : 'LOSS'}
                            </span>
                            <span className="text-sm font-bold text-white">{pipeline.asset}</span>
                            <span className="text-[10px] text-slate-500 font-mono border-l border-white/10 pl-3">{pipeline.strategy}</span>
                        </div>
                        <div className="flex items-center gap-4">
                            <span className="text-[10px] text-slate-500 font-mono">{pipeline.timeStr}</span>
                            <span className={`font-black font-mono text-sm ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>{isWin ? '+' : ''}${pnl.toFixed(4)}</span>
                        </div>
                     </div>

                     <div className="flex flex-col gap-3 pl-2">
                        {pipeline.reasoning && (
                          <div className="border-l-2 border-amber-500/30 pl-4 py-1">
                             <div className="flex items-center justify-between mb-1">
                               <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2"><BrainCircuit size={10}/> Oracle Rationale</h4>
                               {pipeline.reasoning.length > 220 && (
                                 <button
                                   onClick={() => setExpandedThesis(prev => ({ ...prev, [t.id]: !prev[t.id] }))}
                                   className="text-[9px] font-black uppercase tracking-widest text-amber-300 hover:text-amber-200 flex items-center gap-1"
                                 >
                                   {expandedThesis[t.id] ? <>Collapse <ChevronUp size={10}/></> : <>Expand <ChevronDown size={10}/></>}
                                 </button>
                               )}
                             </div>
                             <p className={`text-[11px] text-slate-400 italic whitespace-pre-wrap ${expandedThesis[t.id] ? '' : 'line-clamp-3'}`}>
                               &quot;{pipeline.reasoning}&quot;
                             </p>
                          </div>
                        )}

                        {/* 🧠 Core Memory (Influenced This Trade) */}
                        {(() => {
                          const forwardMems = (t.influencing_memory_ids || [])
                            .map(id => linkedMemories[id] || Object.values(linkedMemories).find(m => String(m.id) === String(id)))
                            .filter(Boolean);
                          if (forwardMems.length === 0) return null;
                          const isExpanded = expandedMemories[`${t.id}-influenced`];
                          return (
                            <div className="border-l-2 border-indigo-500/30 pl-4 py-1">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="text-[9px] font-black uppercase tracking-widest text-indigo-400 flex items-center gap-2">
                                  🧠 Core Memory (Influenced This Trade)
                                </h4>
                                <button
                                  onClick={() => setExpandedMemories(prev => ({ ...prev, [`${t.id}-influenced`]: !prev[`${t.id}-influenced`] }))}
                                  className="text-[9px] font-black uppercase tracking-widest text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
                                >
                                  {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {forwardMems.length} <ChevronDown size={10}/></>}
                                </button>
                              </div>
                              {isExpanded && (
                                <div className="space-y-2 mt-2">
                                  {forwardMems.map(m => (
                                    <div key={m.id} className="bg-black/30 rounded-lg p-3 border border-indigo-500/10">
                                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${m.win_loss === 'WIN' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{m.win_loss}</span>
                                        {m.tenant_id && (
                                          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded ${
                                            String(m.tenant_id) === String(tenantId)
                                              ? 'bg-indigo-500/20 text-indigo-300'
                                              : 'bg-slate-500/20 text-slate-400'
                                          }`}>
                                            {String(m.tenant_id) === String(tenantId) ? '🧠 YOUR MEMORY' : '🌐 SHARED MEMORY'}
                                          </span>
                                        )}
                                        {m.regime_at_close && <span className="text-[8px] font-mono text-slate-500 uppercase">{m.regime_at_close}</span>}
                                        {m.pnl !== null && m.pnl !== undefined && <span className={`text-[9px] font-mono ${parseFloat(m.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${parseFloat(m.pnl).toFixed(4)}</span>}
                                        {m.thesis_accurate !== null && m.thesis_accurate !== undefined && <span className={`text-[8px] font-mono ${m.thesis_accurate ? 'text-emerald-400' : 'text-red-400'}`}>{m.thesis_accurate ? '✓ Accurate' : '✗ Inaccurate'}</span>}
                                      </div>
                                      <p className="text-[11px] text-slate-400 italic leading-relaxed line-clamp-3">{m.lesson_learned}</p>
                                      {m.working_thesis && (
                                        <p className="text-[9px] text-slate-500 mt-1.5 pt-1.5 border-t border-indigo-500/10 leading-relaxed">
                                          <span className="font-black uppercase tracking-widest text-indigo-400">Thesis:</span> {m.working_thesis}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 🧠 Core Memory (Generated By This Trade) */}
                        {(() => {
                          const generatedMem = Object.values(linkedMemories)
                            .filter(m => m.trade_log_id && String(m.trade_log_id) === String(t.id));
                          if (generatedMem.length === 0) return null;
                          const isExpanded = expandedMemories[`${t.id}-generated`];
                          return (
                            <div className="border-l-2 border-emerald-500/30 pl-4 py-1">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="text-[9px] font-black uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                                  🧠 Core Memory (Generated By This Trade)
                                </h4>
                                <button
                                  onClick={() => setExpandedMemories(prev => ({ ...prev, [`${t.id}-generated`]: !prev[`${t.id}-generated`] }))}
                                  className="text-[9px] font-black uppercase tracking-widest text-emerald-300 hover:text-emerald-200 flex items-center gap-1"
                                >
                                  {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {generatedMem.length} <ChevronDown size={10}/></>}
                                </button>
                              </div>
                              {isExpanded && (
                                <div className="space-y-2 mt-2">
                                  {generatedMem.map(m => (
                                    <div key={m.id} className="bg-black/30 rounded-lg p-3 border border-emerald-500/10">
                                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${m.win_loss === 'WIN' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{m.win_loss}</span>
                                        {m.tenant_id && (
                                          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded ${
                                            String(m.tenant_id) === String(tenantId)
                                              ? 'bg-indigo-500/20 text-indigo-300'
                                              : 'bg-slate-500/20 text-slate-400'
                                          }`}>
                                            {String(m.tenant_id) === String(tenantId) ? '🧠 YOUR MEMORY' : '🌐 SHARED MEMORY'}
                                          </span>
                                        )}
                                        {m.regime_at_close && <span className="text-[8px] font-mono text-slate-500 uppercase">{m.regime_at_close}</span>}
                                        {m.pnl !== null && m.pnl !== undefined && <span className={`text-[9px] font-mono ${parseFloat(m.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${parseFloat(m.pnl).toFixed(4)}</span>}
                                        {m.thesis_accurate !== null && m.thesis_accurate !== undefined && <span className={`text-[8px] font-mono ${m.thesis_accurate ? 'text-emerald-400' : 'text-red-400'}`}>{m.thesis_accurate ? '✓ Accurate' : '✗ Inaccurate'}</span>}
                                      </div>
                                      <p className="text-[11px] text-slate-400 italic leading-relaxed line-clamp-3">{m.lesson_learned}</p>
                                      {m.working_thesis && (
                                        <p className="text-[9px] text-slate-500 mt-1.5 pt-1.5 border-t border-emerald-500/10 leading-relaxed">
                                          <span className="font-black uppercase tracking-widest text-emerald-400">Thesis:</span> {m.working_thesis}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 🛠️ Agent Tool Calls */}
                        {t && (() => {
                          const toolCalls = toolCallsMap[t.id] || [];
                          if (toolCalls.length === 0) return null;
                          const isExpanded = expandedMemories[`${t.id}-tools`];
                          return (
                            <div className="border-l-2 border-amber-500/30 pl-4 py-1">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2">
                                  <Crosshair size={12}/> Agent Tool Calls ({toolCalls.length})
                                </h4>
                                <button
                                  onClick={() => setExpandedMemories(prev => ({ ...prev, [`${t.id}-tools`]: !prev[`${t.id}-tools`] }))}
                                  className="text-[9px] font-black uppercase tracking-widest text-amber-300 hover:text-amber-200 flex items-center gap-1"
                                >
                                  {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {toolCalls.length} <ChevronDown size={10}/></>}
                                </button>
                              </div>
                              {isExpanded && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden max-h-[300px] overflow-y-auto">
                                  <table className="w-full text-[10px] font-mono">
                                    <thead>
                                      <tr className="border-b border-white/5 text-[8px] uppercase tracking-widest text-slate-500 sticky top-0 bg-black/90">
                                        <th className="px-3 py-2 text-left">Tool</th>
                                        <th className="px-3 py-2 text-center">Tier</th>
                                        <th className="px-3 py-2 text-center">Stage</th>
                                        <th className="px-3 py-2 text-left">Why</th>
                                        <th className="px-3 py-2 text-right">Duration</th>
                                        <th className="px-3 py-2 text-right">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {toolCalls.map(tc => {
                                        const info = getTierInfo(tc.tool_name);
                                        const [stageLetter] = info.stage === 1 ? ['E'] :
                                          info.stage === 2 ? ['V'] :
                                          info.stage === 3 ? ['D'] :
                                          info.stage === 4 ? ['R'] :
                                          info.stage === 'SYSTEM' ? ['S'] :
                                          info.stage === 'EXECUTION' ? ['X'] : ['?'];
                                        return (
                                        <tr key={tc.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{tc.tool_name.replace('coinglass_', 'cg_')}</td>
                                          <td className="px-3 py-2 text-center">
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black"
                                              style={{ backgroundColor: `${info.tierColor}20`, color: info.tierColor, border: `1px solid ${info.tierColor}40` }}
                                              title={info.tierLabel}>
                                              {typeof info.tier === 'number' ? `T${info.tier}` : info.tier === 'SYSTEM' ? '⚙️' : info.tier === 'EXECUTION' ? '▶️' : '?'}
                                            </span>
                                          </td>
                                          <td className="px-3 py-2 text-center">
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black"
                                              style={{ backgroundColor: `${getStageColor(info.stage)}20`, color: getStageColor(info.stage), border: `1px solid ${getStageColor(info.stage)}40` }}
                                              title={info.stageLabel}>
                                              {stageLetter}
                                            </span>
                                          </td>
                                          <td className="px-3 py-2 text-left text-slate-400 text-[9px] leading-tight max-w-[200px] truncate" title={info.reason}>
                                            {info.reason}
                                          </td>
                                          <td className="px-3 py-2 text-right text-slate-400 whitespace-nowrap">{tc.duration_ms}ms</td>
                                          <td className="px-3 py-2 text-right">
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                                              tc.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                            }`}>
                                              {tc.status === 'success' ? 'OK' : 'ERR'}
                                            </span>
                                          </td>
                                        </tr>
                                      )})}
                                    </tbody>
                                  </table>
                                  {toolCalls.some(tc => tc.response_summary) && (
                                    <div className="p-3 border-t border-white/5 bg-black/30">
                                      <p className="text-[8px] uppercase tracking-widest text-slate-500 mb-1">Response:</p>
                                      <pre className="text-[9px] text-slate-400 whitespace-pre-wrap break-all leading-relaxed">
                                        {toolCalls.map(tc => `[${tc.tool_name}] ${tc.response_summary || ''}`).join('\n').substring(0, 500)}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        
                        <div className="border-l-2 border-slate-500/30 pl-4 py-1 flex flex-wrap gap-x-6 gap-y-2">
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Entry:</span>
                              <span className="text-[11px] font-mono text-white">${t.entry_price || 0}</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Exit:</span>
                              <span className="text-[11px] font-mono text-white">${t.exit_price || 0}</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Side:</span>
                              <span className={`text-[11px] font-black uppercase ${t.side === 'BUY' || t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side}</span>
                           </div>
                           {typeof t.reason === 'string' && t.reason.includes('[EXIT TRIGGER]') && (
                             <div className="flex items-center gap-2">
                                <span className="text-[9px] text-slate-500 uppercase tracking-widest">Trigger:</span>
                                <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-white/10 uppercase">
                                  {t.reason.split('[EXIT TRIGGER]:')[1]?.trim()}
                                </span>
                             </div>
                           )}
                        </div>
                     </div>
                  </div>
                );
             })}
             
             {/* 🛡️ SHADOW LEDGER block (PUSH AD, AH2 chip) — full-data ledger from
                 timeline.vetoes (reason/memories/tools), day-grouped + filtered by
                 the calendar selection, with pts nets per day. Amounts = price
                 POINTS, never $. */}
             {showShadowLedger && vetoGroups.map(group => (
               <div key={group.date} className="flex flex-col gap-2">
                 {/* Day header — amounts are price POINTS, never $ */}
                 <div className="flex flex-wrap items-center gap-3 py-2 border-b border-white/5 text-[9px] md:text-[10px] font-black uppercase tracking-widest font-mono">
                   <span className="text-slate-400">{group.date}</span>
                   <span className={group.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                     {group.net >= 0 ? '+' : '−'}{Math.abs(group.net).toFixed(2)} pts net
                   </span>
                   <span className="text-slate-600">({group.saved} saved / {group.missed} missed)</span>
                 </div>

                 {group.rows.map(v => (
                   <ShadowLedgerCard
                     key={v.scan_id ?? v.veto_time}
                     v={v}
                     expandedKey={String(v.scan_id ?? v.veto_time)}
                     expandedMap={expandedReason}
                     onToggle={toggleReason}
                   />
                 ))}
               </div>
             ))}

             {showRiskBlocks && riskBlocks.map((rb, i) => (
               <div key={i} className="p-4 rounded-2xl border border-red-500/20 bg-slate-900/60">
                 <div className="flex justify-between items-center mb-2">
                   <div className="flex items-center gap-3">
                     <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest bg-red-500/10 text-red-400">RISK BLOCK</span>
                     <span className="text-sm font-bold text-white">{rb.asset}</span>
                     <span className="text-[10px] text-slate-500 font-mono">{rb.execution_mode}</span>
                   </div>
                   <span className="text-[10px] text-slate-500 font-mono">{new Date(rb.created_at).toLocaleString()}</span>
                 </div>
                 <div className="flex flex-wrap gap-3 text-[10px] text-slate-400 font-mono pl-2 mb-2">
                   <span>{rb.side} {rb.entry_price ? `@ $${rb.entry_price}` : ''}</span>
                   <span>Qty: {rb.qty}</span>
                   <span>{rb.leverage}x</span>
                 </div>
                 <div className="border-l-2 border-red-500/30 pl-3">
                   <p className="text-[11px] text-red-300 italic">{rb.reason}</p>
                 </div>
               </div>
             ))}

             {displayLogs.length === 0 && !showLogs && !showRiskBlocks && <div className="text-[10px] font-mono text-slate-600 pl-2">No executed trades match these filters.</div>}
             {showShadowLedger && vetoGroups.length === 0 && <div className="text-[10px] font-mono text-slate-600 pl-2">No SHADOW records found for this tenant.</div>}
             {displayLogs.length === 0 && showRiskBlocks && riskBlocks.length === 0 && <div className="text-[10px] font-mono text-slate-600 pl-2">No Risk Block records found for this tenant.</div>}
          </div>
        </div>
      )}
    </div>
  );
}