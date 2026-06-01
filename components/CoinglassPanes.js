// components/CoinglassPanes.js
// Renders the user-selected Coinglass "pane" indicators stacked horizontally
// below the chart. Each card auto-refreshes every 30s and shows the key
// telemetry (regime + current value) the indicator function returned.
//
// This intentionally uses a compact card-strip rather than a full secondary
// chart series so it stays performant and looks tidy on the dashboard.

import React, { useEffect, useState } from 'react';

export default function CoinglassPanes({ asset, indicators, token, timeframe }) {
  const [data, setData] = useState({}); // { [id]: { loading, data, error } }

  useEffect(() => {
    if (!asset || !token || !indicators?.length) return;
    let cancelled = false;

    const fetchOne = async (ind) => {
      setData(prev => ({ ...prev, [ind.id]: { ...(prev[ind.id] || {}), loading: true } }));
      try {
        // Pass the chart's selected timeframe so the returned series aligns to
        // what the user is looking at.
        const tfParam = timeframe ? `&interval=${encodeURIComponent(timeframe)}` : '';
        const res = await fetch(`/api/coinglass-indicator?id=${encodeURIComponent(ind.id)}&symbol=${encodeURIComponent(asset)}${tfParam}`,
          { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (!cancelled) {
          setData(prev => ({ ...prev, [ind.id]: { loading: false, data: json?.data, error: !res.ok ? (json?.error || `HTTP ${res.status}`) : null } }));
        }
      } catch (e) {
        if (!cancelled) {
          setData(prev => ({ ...prev, [ind.id]: { loading: false, error: e.message } }));
        }
      }
    };

    indicators.forEach(fetchOne);
    const interval = setInterval(() => indicators.forEach(fetchOne), 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [asset, token, indicators, timeframe]);

  if (!indicators?.length) return null;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
      {indicators.map((ind) => {
        const state = data[ind.id] || { loading: true };
        return (
          <div key={ind.id} className="bg-slate-900/40 border border-white/5 rounded-xl p-2.5 min-h-[60px]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{ind.label}</span>
              {state.loading && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />}
            </div>
            {state.error && (
              <div className="text-[10px] text-red-400 font-mono">⚠️ {state.error}</div>
            )}
            {!state.error && state.data && <CoinglassValue data={state.data} />}
            {!state.error && state.data?.series?.length > 1 && <HeatStrip series={state.data.series} />}
            {!state.error && !state.data && !state.loading && (
              <div className="text-[10px] text-slate-600 font-mono">No data</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Best-effort renderer for the heterogeneous indicator payloads from
// lib/coinglass_*_v4.js. Each function returns its own shape, so we look for
// the common keys we know about and gracefully fall back to JSON.
function CoinglassValue({ data }) {
  if (data == null) return null;
  if (typeof data !== 'object') {
    return <div className="text-sm font-mono font-bold text-white">{String(data)}</div>;
  }

  // Common patterns across the coinglass_*_v4 helpers:
  const regime = data.regime || data.status || data.signal || data.state;
  const value = data.value ?? data.current ?? data.score ?? data.percent ?? data.ratio;
  const reasoning = data.reasoning || data.description;

  if (regime || value !== undefined) {
    return (
      <div>
        <div className="flex items-baseline gap-2">
          {value !== undefined && <span className="text-base font-mono font-black text-white">{typeof value === 'number' ? value.toFixed(2) : String(value)}</span>}
          {regime && <span className="text-[9px] font-black uppercase tracking-widest text-indigo-300">{String(regime)}</span>}
        </div>
        {reasoning && <div className="text-[9px] text-slate-500 mt-1 line-clamp-2">{reasoning}</div>}
      </div>
    );
  }
  // Fallback: show a compact summary (skip the raw series array — it's rendered
  // as a heat strip below).
  const keys = Object.keys(data).filter(k => k !== 'series').slice(0, 3);
  return (
    <div className="text-[10px] font-mono text-slate-300">
      {keys.map(k => <div key={k}><span className="text-slate-500">{k}:</span> {typeof data[k] === 'object' ? '…' : String(data[k]).slice(0, 32)}</div>)}
    </div>
  );
}

// Compact time-aligned heat strip for a series of { time, value }. Each bar is
// colored by its value's z-score (cold blue -> hot red), giving a legend.coinglass
// "intensity over time" read at a glance.
function HeatStrip({ series }) {
  const vals = series.map(s => Number(s.value)).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  // Show the most recent ~60 bars.
  const recent = series.slice(-60);
  return (
    <div className="mt-1.5 flex items-end gap-px h-6">
      {recent.map((s, i) => {
        const z = (Number(s.value) - mean) / std;
        const clamped = Math.max(-2.5, Math.min(2.5, z));
        // Height by magnitude, color by signed intensity.
        const h = 20 + Math.min(80, Math.abs(clamped) * 32);
        const hot = clamped >= 0;
        const a = 0.35 + Math.min(0.6, Math.abs(clamped) / 2.5 * 0.6);
        const color = hot
          ? `rgba(${Math.round(120 + clamped * 54)}, ${Math.round(70 - clamped * 10)}, 60, ${a})`
          : `rgba(40, ${Math.round(120 + Math.abs(clamped) * 40)}, ${Math.round(160 + Math.abs(clamped) * 30)}, ${a})`;
        return <div key={i} className="flex-1 rounded-sm" style={{ height: `${h}%`, background: color }} title={`${new Date(s.time * 1000).toLocaleString()} · ${Number(s.value).toFixed(4)}`} />;
      })}
    </div>
  );
}
