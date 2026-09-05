import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { Trophy, ArrowLeft, ShieldAlert, Award, TrendingUp, BarChart2 } from 'lucide-react';

export default function Leaderboard() {
  const [windowKey, setWindowKey] = useState('30D');
  const [mode, setMode] = useState('LIVE');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

      {/* Top Navigation */}
      <header className="border-b border-white/5 bg-slate-900/40 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-xs font-bold uppercase tracking-wider">
              <ArrowLeft className="w-4 h-4" /> Nexus Terminal
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[10px] uppercase font-black tracking-widest text-emerald-400">Public Rolling Rank</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-10">
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
                {w}
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
                  <th className="py-3.5 px-4 text-right">Best Trade (R)</th>
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
                      <td className="py-4 px-4"><div className="h-4 w-14 bg-slate-800 rounded ml-auto"></div></td>
                    </tr>
                  ))
                ) : error ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-rose-400">
                      <ShieldAlert className="w-6 h-6 mx-auto mb-2 opacity-80" />
                      <p className="text-xs font-semibold">{error}</p>
                    </td>
                  </tr>
                ) : !data?.rows || data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-slate-500">
                      <Award className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm font-bold text-slate-400">No qualifying agents for this period</p>
                      <p className="text-xs mt-1 text-slate-600">Requires a minimum of 5 closed trades in the selected window.</p>
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row, idx) => {
                    const rank = idx + 1;
                    const isTop3 = rank <= 3;
                    const rankBadgeColor =
                      rank === 1 ? 'text-amber-400 bg-amber-400/10 border-amber-400/30' :
                      rank === 2 ? 'text-slate-300 bg-slate-300/10 border-slate-300/30' :
                      rank === 3 ? 'text-amber-600 bg-amber-600/10 border-amber-600/30' :
                      'text-slate-500 bg-slate-800/40 border-transparent';

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
                            {isTop3 && <Award className="w-3.5 h-3.5 text-amber-400" />}
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
                          <span className={row.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {row.totalPnl >= 0 ? `+$${row.totalPnl.toFixed(2)}` : `-$${Math.abs(row.totalPnl).toFixed(2)}`}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-300">
                          {row.bestR > 0 ? `+${row.bestR.toFixed(2)}R` : `${row.bestR.toFixed(2)}R`}
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
