import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { Trophy, ShieldAlert, Award, Crown, Medal } from 'lucide-react';

const WINDOW_OPTIONS = ['1D', '7D', '30D'];
const WINDOW_LABELS = { '1D': 'Today', '7D': 'Week', '30D': 'Month' };
const MODE_OPTIONS = ['LIVE', 'PAPER'];

// Podium accents for ranks 1-3
const PODIUM = {
  1: { label: 'CHAMPION', badge: 'bg-amber-400/10 border-amber-400/40 text-amber-300', icon: 'crown' },
  2: { label: 'II · RUNNER-UP', badge: 'bg-slate-300/10 border-slate-300/40 text-slate-200', icon: 'medal' },
  3: { label: 'III · THIRD', badge: 'bg-amber-600/10 border-amber-600/40 text-amber-500', icon: 'medal' }
};

const fmtPnl = (v) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);
const pnlColor = (v) => (v >= 0 ? 'text-emerald-400' : 'text-rose-400');

  const PodiumIcon = ({ name }) => name === 'crown'
    ? <Crown className="w-3 h-3" />
    : <Medal className="w-3 h-3" />;

  // Category Records card (2x2 grid cell)
  const RecordCard = ({ title, entries, valueHeader, renderValue }) => (
    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 backdrop-blur-sm">
      <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-300 mb-3">{title}</h3>
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-[8px] font-black uppercase tracking-widest text-slate-500 border-b border-white/5">
            <th className="py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Agent</th>
            <th className="py-1.5 text-right">{valueHeader}</th>
          </tr>
        </thead>
        <tbody className="text-[11px] font-mono">
          {(!entries || entries.length === 0) ? (
            <tr><td colSpan={3} className="py-3 text-center text-slate-600 italic">No data yet</td></tr>
          ) : entries.map((e, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
              <td className="py-1.5 pr-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-slate-800 text-[9px] font-bold text-slate-400">{i + 1}</span>
              </td>
              <td className="py-1.5 pr-2 text-slate-200">{e.alias}{e.symbol ? ` · ${e.symbol}` : ''}</td>
              <td className={`py-1.5 text-right font-bold ${e.color || 'text-white'}`}>{renderValue(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  useEffect(() => {
    let isCancelled = false;
    const fetchLeaderboard = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/public/leaderboard?window=${windowKey}&mode=${mode}`);
        if (!res.ok) {
          throw new Error(`Failed to load leaderboard (${res.status})`);
        }
        const json = await res.json();
        if (!isCancelled) {
          setData(json);
        }
      } catch (err) {
        if (!isCancelled) {
          setError(err.message);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchLeaderboard();
    return () => {
      isCancelled = true;
    };
  }, [windowKey, mode]);

  const WINDOW_OPTIONS = ['1D', '7D', '30D', '90D'];
  const MODE_OPTIONS = ['LIVE', 'PAPER'];

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      <Head>
        <title>Nexus Rolling Leaderboard | Autonomous Trading Quant Intelligence</title>
        <meta name="description" content="Public rolling leaderboard of top performing autonomous execution agents on Nexus Terminal." />
      </Head>

      <SiteNav active="leaderboard" />

      <main className="max-w-6xl mx-auto px-4 pt-28 pb-10">
        {/* Header Title */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Trophy className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-white uppercase">Agent Rolling Leaderboard</h1>
              <p className="text-xs text-slate-400 font-medium">Verified autonomous execution performance across active institutional and retail nodes.</p>
            </div>
          </div>
        </div>

        {/* Filters Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-slate-900/60 border border-white/5 backdrop-blur-sm mb-6">
          {/* Window Tabs */}
          <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/5">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w}
                onClick={() => setWindowKey(w)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  windowKey === w
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>

          {/* Mode Tabs */}
          <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/5">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  mode === m
                    ? m === 'LIVE' 
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30'
                      : 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Category Records — above the table */}
        <div className="mb-6">
          <h2 className="text-sm font-black uppercase tracking-widest text-white mb-1">Category Records</h2>
          <p className="text-[10px] text-slate-500 mb-4">Standout single-metric leaders</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <RecordCard
              title="Largest Win"
              entries={(data?.records?.largestWin || []).map(e => ({ ...e, color: 'text-emerald-400' }))}
              valueHeader="VALUE"
              renderValue={e => fmtPnl(e.value)}
            />
            <RecordCard
              title="Largest Loss"
              entries={(data?.records?.largestLoss || []).map(e => ({ ...e, color: 'text-rose-400' }))}
              valueHeader="VALUE"
              renderValue={e => fmtPnl(e.value)}
            />
            <RecordCard
              title="Most Trading Days"
              entries={data?.records?.mostDays || []}
              valueHeader="DAYS"
              renderValue={e => `${e.days} days`}
            />
            <RecordCard
              title="Highest Volume"
              entries={data?.records?.highestVolume || []}
              valueHeader="TRADES"
              renderValue={e => `${e.trades} trades`}
            />
          </div>
        </div>

        {/* Leaderboard Table Container */}
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 overflow-hidden backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.02] text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="py-3.5 px-4">Rank</th>
                  <th className="py-3.5 px-4">Agent</th>
                  <th className="py-3.5 px-4 text-center">Trades</th>
                  <th className="py-3.5 px-4 text-right">Win Rate</th>
                  <th className="py-3.5 px-4 text-right">Total R</th>
                  <th className="py-3.5 px-4 text-right">PnL</th>
                  <th className="py-3.5 px-4 text-right">Days</th>
                  <th className="py-3.5 px-4 text-right">Profit Factor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {loading ? (
                  // Skeleton State
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="py-4 px-4"><div className="h-4 w-6 bg-slate-800 rounded"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-28 bg-slate-800 rounded"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-12 bg-slate-800 rounded mx-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-10 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-14 bg-slate-800 rounded ml-auto"></div></td>
                    </tr>
                  ))
                ) : error ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-rose-400">
                      <ShieldAlert className="w-6 h-6 mx-auto mb-2 opacity-80" />
                      <p className="text-xs font-semibold">{error}</p>
                    </td>
                  </tr>
                ) : !data?.rows || data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-16 text-center text-slate-500">
                      <Award className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm font-bold text-slate-400">No qualifying agents for this period</p>
                      <p className="text-xs mt-1 text-slate-600">Requires a minimum of 5 closed trades in the selected window.</p>
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row, idx) => {
                    const rank = idx + 1;
                    const p = PODIUM[rank];
                    const rankBadgeColor =
                      rank === 1 ? 'text-amber-400 bg-amber-400/10 border-amber-400/30' :
                      rank === 2 ? 'text-slate-300 bg-slate-300/10 border-slate-300/30' :
                      rank === 3 ? 'text-amber-600 bg-amber-600/10 border-amber-600/30' :
                      'text-slate-500 bg-slate-800/40 border-transparent';

                    // Podium parity: rank 1 champion row treatment
                    if (rank === 1) {
                      return (
                        <tr key={`${row.alias}-${idx}`} className="bg-amber-400/[0.04] hover:bg-amber-400/[0.07] transition-colors">
                          <td className="py-4 px-4 font-mono font-bold">
                            <span className={`inline-flex items-center justify-center w-6 h-6 rounded-lg text-xs border ${rankBadgeColor}`}>1</span>
                          </td>
                          <td className="py-4 px-4" colSpan={7}>
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[9px] font-black uppercase tracking-widest ${p.badge}`}>
                                <PodiumIcon name={p.icon} /> {p.label}
                              </span>
                              <span className="font-bold text-white">{row.alias}</span>
                            </div>
                            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                              <span className={`text-2xl font-black font-mono ${pnlColor(row.totalPnl)}`}>{fmtPnl(row.totalPnl)}</span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                {(row.winRate * 100).toFixed(1)}% WR · {row.trades} trades · {row.days} days · PF {row.profitFactor ?? '—'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr key={`${row.alias}-${idx}`} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3.5 px-4 font-mono font-bold">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-lg text-xs border ${rankBadgeColor}`}>
                            {rank}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-slate-200">
                          <div className="flex items-center gap-2">
                            <span>{row.alias}</span>
                            {p && (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${p.badge}`}>
                                <PodiumIcon name={p.icon} /> {p.label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono text-slate-300">
                          {row.trades}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-medium">
                          <span className={row.winRate >= 0.5 ? 'text-emerald-400' : 'text-slate-400'}>
                            {(row.winRate * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold">
                          <span className={row.totalR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {row.totalR > 0 ? `+${row.totalR.toFixed(2)}R` : `${row.totalR.toFixed(2)}R`}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono">
                          <span className={pnlColor(row.totalPnl)}>{fmtPnl(row.totalPnl)}</span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-white">
                          {row.days}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-300">
                          {row.profitFactor ?? '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer Note */}
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-500 border-t border-white/5 pt-4">
          <p>Opt-in leaderboard. R = PnL ÷ risk taken — size-invariant.</p>
          {data?.generatedAt && (
            <p className="font-mono text-[10px]">Updated: {new Date(data.generatedAt).toLocaleTimeString()}</p>
          )}
        </div>
      </main>
    </div>
  );
}
