// components/StudioTheater.js
// PUSH AM52b — Studio Episode Theater. Passive observer of the studio_runs
// feed: polls every 2s, new run_id -> animated card at top; older cards
// collapse to final frame + stats. Read-only; agent loop untouched.

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Activity, AlertCircle } from 'lucide-react';
import BacktestChart from './BacktestChart.js';

const REGIME_ORDER = ['TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'];
const REGIME_STYLES = {
  TREND: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  CHOP: 'bg-slate-500/10 text-slate-300 border border-slate-500/20',
  ACCUMULATION: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  DISTRIBUTION: 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
};

const POLL_MS = 2000;
const EPISODE_FRESH_MS = 30000;

const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const arrow = (d) => (d > 0 ? '▲' : d < 0 ? '▼' : '');
const arrowCls = (d) => (d > 0 ? 'text-emerald-400' : d < 0 ? 'text-rose-500' : 'text-slate-500');

export default function StudioTheater({ session, visible }) {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const seenIdsRef = useRef(null);
  const [animating, setAnimating] = useState({}); // runId -> true while card animates

  // Poll feed every 2s while visible
  useEffect(() => {
    if (!visible || !session?.access_token) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/studio-runs?limit=10', {
          headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const incoming = Array.isArray(data.runs) ? data.runs : [];
        setRuns(incoming);
        setError('');
        // Mark any run newer than what we've seen as animating
        const newestId = incoming[0]?.id;
        if (newestId && seenIdsRef.current !== null && newestId !== seenIdsRef.current) {
          setAnimating((prev) => ({ ...prev, [newestId]: true }));
        }
        if (seenIdsRef.current === null && incoming[0]?.id) {
          seenIdsRef.current = incoming[0].id; // first poll: don't animate history
        } else if (newestId) {
          seenIdsRef.current = newestId;
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };

    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [visible, session?.access_token]);

  // ticker for episode-fresh pulse
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  // Baseline pinning (PUSH AM52c): the oldest of the last-10 runs drifts forward
  // as runs accumulate, so instead pin to the first run after a >5-minute gap in
  // created_at — i.e. the start of the current episode. Runs arrive newest-first.
  const baseline = useMemo(() => {
    if (!runs.length) return null;
    const GAP_MS = 5 * 60 * 1000;
    for (let i = 1; i < runs.length; i++) {
      const newer = new Date(runs[i - 1].created_at).getTime();
      const older = new Date(runs[i].created_at).getTime();
      if (Number.isFinite(newer) && Number.isFinite(older) && newer - older > GAP_MS) {
        return runs[i];
      }
    }
    return runs[runs.length - 1]; // no gap: whole window is one episode
  }, [runs]);

  const isFresh = (r) => r && (now - new Date(r.created_at).getTime()) < EPISODE_FRESH_MS;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" /> Episode Theater
        </h3>
        {runs[0] && isFresh(runs[0]) && (
          <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-cyan-300">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" /> Episode running
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-400">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {!runs.length && (
        <div className="text-xs text-slate-500 font-mono bg-slate-900/40 border border-white/5 rounded-xl p-6 text-center">
          No runs yet — run a backtest or ask the agent to iterate.
        </div>
      )}

      <div className="space-y-4">
        {runs.map((run) => {
          const s = run.summary || {};
          const rb = run.regime_breakdown || {};
          const trades = run.trades || [];
          const isBaseline = !!baseline && run.id === baseline.id;
          const animate = animating[run.id];

          // deltas vs baseline (skip for baseline itself)
          const dTrades = baseline && !isBaseline ? (s.total_trades - (baseline.summary?.total_trades ?? 0)) : 0;
          const dWr = baseline && !isBaseline ? ((s.win_rate ?? 0) - (baseline.summary?.win_rate ?? 0)) : 0;
          const dPf = baseline && !isBaseline ? ((s.profit_factor ?? 0) - (baseline.summary?.profit_factor ?? 0)) : 0;
          const dPnl = baseline && !isBaseline ? ((s.pnl_percent ?? 0) - (baseline.summary?.pnl_percent ?? 0)) : 0;

          const provenanceBad = baseline && !isBaseline && (
            run.product !== baseline.product || run.horizon !== baseline.horizon
          );

          return (
            <div key={run.id} className={`bg-slate-900/50 border rounded-2xl p-4 space-y-3 ${provenanceBad ? 'border-rose-500/50' : 'border-white/5'}`}>
              {/* Provenance strip */}
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 flex-wrap">
                <span className="text-cyan-400 font-bold">{run.product}</span>
                <span>•</span>
                <span>first_close {run.first_close != null ? '$' + Number(run.first_close).toLocaleString() : '—'}</span>
                <span>•</span>
                <span>{run.run_window ? `${run.run_window.days}d` : '—'} window</span>
                <span>•</span>
                <span>{run.horizon || '—'}</span>
                {provenanceBad && (
                  <span className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 font-black uppercase text-[9px]">
                    <AlertCircle className="w-3 h-3" /> Mismatch
                  </span>
                )}
                {isBaseline && (
                  <span className="ml-auto px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-black uppercase text-[9px]">Baseline</span>
                )}
              </div>

              {/* Chart (older cards keep final frame; theater mode animates the newest) */}
              <div className="h-[220px] rounded-xl overflow-hidden border border-white/5 bg-slate-950/80">
                <BacktestChart data={run} mode="theater" height={220} equityHeight={80} />
              </div>

              {/* Stats + deltas */}
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  { label: 'Trades', val: s.total_trades ?? 0, d: dTrades, fmt: (v) => v, dfmt: (d) => String(Math.abs(d)) },
                  { label: 'WR', val: pct(s.win_rate), d: dWr, fmt: () => pct(s.win_rate) + ' ' + arrow(dWr), dfmt: (d) => (Math.abs(d) * 100).toFixed(1) + '%' },
                  { label: 'PF', val: s.profit_factor ?? '—', d: dPf, fmt: () => (s.profit_factor ?? '—') + ' ' + arrow(dPf), dfmt: (d) => Math.abs(d).toFixed(2) },
                  { label: 'PnL%', val: (s.pnl_percent ?? 0) + '%', d: dPnl, fmt: () => (s.pnl_percent ?? 0) + '%', dfmt: (d) => Math.abs(d).toFixed(1) + '%' }
                ].map((m) => (
                  <div key={m.label} className="bg-slate-950/60 rounded-lg px-1 py-2 border border-white/5">
                    <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">{m.label}</div>
                    <div className="text-xs font-bold">
                      {m.fmt()}
                    </div>
                    {!isBaseline && m.d !== 0 && (
                      <div className={`text-[9px] font-mono ${arrowCls(m.d)}`}>{arrow(m.d)} {m.dfmt(m.d)}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Regime chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {REGIME_ORDER.map((r) => {
                  const b = rb[r] || { n: 0 };
                  return (
                    <span key={r} className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${REGIME_STYLES[r] || REGIME_STYLES.CHOP} ${b.n === 0 ? 'opacity-40' : ''}`}>
                      {r} n={b.n}
                    </span>
                  );
                })}
              </div>

              {/* Params diff vs baseline */}
              {!isBaseline && baseline?.parameters && run.parameters && (
                <div className="text-[10px] font-mono space-y-0.5">
                  {Object.keys({ ...baseline.parameters, ...run.parameters }).map((k) => {
                    const a = baseline.parameters[k], b = run.parameters[k];
                    if (String(a) === String(b)) return null;
                    return (
                      <div key={k} className="flex gap-1">
                        <span className="text-slate-500">{k}:</span>
                        <span className="text-slate-400 line-through">{String(a)}</span>
                        <span className="text-amber-400 font-bold">{String(b)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
