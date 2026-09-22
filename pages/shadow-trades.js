// pages/shadow-trades.js
// 🟢 PUSH AM10 — Shadow Trades: trades-table parity for the shadow book.
// Mirrors the opened-trades table in pages/index.js (same columns/row layout/
// refresh cadence), fed from /api/shadow-trades (shadow_portfolio).
// SIM-ONLY: no close/force-close action — a shadow resolves via its own sim.
import { useState, useEffect, useCallback } from 'react';
import { useSession } from '@supabase/auth-helpers-react';
import Head from 'next/head';
import Link from 'next/link';
import { Layers, RefreshCw, FlaskConical, ArrowLeft } from 'lucide-react';

const REFRESH_MS = 15000; // same cadence as the trades table on the dashboard

export default function ShadowTrades() {
  const session = useSession();
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadTrades = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch('/api/shadow-trades', {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `API returned ${res.status}`);
      }
      const data = await res.json();
      setTrades(data.trades || []);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    loadTrades();
    const iv = setInterval(loadTrades, REFRESH_MS);
    return () => clearInterval(iv);
  }, [loadTrades]);

  const openCount = trades.filter(t => t.status === 'OPEN').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <Head>
        <title>Shadow Trades — Nexus</title>
      </Head>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-slate-500 hover:text-slate-300 transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <h1 className="text-sm font-black uppercase tracking-widest text-slate-300 flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-purple-400" /> Shadow Trades
              <span className="bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full text-[9px] font-mono uppercase tracking-widest">SIM ONLY</span>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-[9px] text-slate-600 font-mono">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={loadTrades}
              className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 px-3 py-1.5 rounded-lg transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] font-bold px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        {/* Table — same columns/row layout as the dashboard trades table */}
        <div className="dark:bg-slate-900/50 bg-slate-900/50 border border-white/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-3 border-b border-white/5 bg-slate-950/40 flex items-center justify-between">
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
              Shadow Book {openCount > 0 && <span className="ml-1 bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full text-[8px]">{openCount} open</span>}
            </span>
          </div>
          <div className="overflow-y-auto overflow-x-auto custom-scrollbar max-h-[calc(100vh-220px)]">
            {trades.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12 min-h-[200px]">
                <Layers size={24} className="mb-2 opacity-50" />
                <p className="text-[11px] font-bold uppercase tracking-widest">
                  {loading ? 'Loading…' : 'No shadow trades yet'}
                </p>
              </div>
            ) : (
              <table className="w-full min-w-max text-left">
                <thead className="bg-slate-950/40 text-[8px] sm:text-[9px] font-black text-slate-600 uppercase tracking-widest sticky top-0 backdrop-blur-md z-10">
                  <tr>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px]">Date</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[80px] sm:min-w-[100px] text-center">Context</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[50px] sm:min-w-[60px] text-center">Vector</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[80px] text-center">Entry</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[70px] sm:min-w-[80px] text-center">Targets</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px]">Status</th>
                    <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px] text-right">PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-[8px] sm:text-xs text-slate-400">
                  {trades.map((t, i) => {
                    const isOpen = t.status === 'OPEN';
                    const timestamp = t.opened_at;
                    const d = timestamp ? new Date(timestamp) : null;
                    const formattedDate = d ? d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: '2-digit' }) : '';
                    const formattedTime = d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

                    let pnlDisplay = '--';
                    if (t.pnl != null) {
                      pnlDisplay = <span className={t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}</span>;
                    }

                    return (
                      <tr key={t.id || i} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 whitespace-nowrap">
                          <div className="flex flex-col leading-tight">
                            <span className="text-[8px] sm:text-[10px] font-bold text-slate-300">{formattedDate}</span>
                            <span className="text-[7px] sm:text-[9px] font-mono text-slate-500">{formattedTime}</span>
                          </div>
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-center">
                          <span className="text-[7px] sm:text-[8px] font-black uppercase px-1.5 sm:px-2 py-0.5 rounded border bg-purple-500/10 text-purple-300 border-purple-500/20">
                            {t.symbol ?? '—'}
                          </span>
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-center">
                          <span className={`px-1.5 sm:px-2 py-0.5 rounded-full text-[7px] sm:text-[9px] font-black whitespace-nowrap ${t.side === 'BUY' || t.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                            {t.side ?? '—'} ({t.qty ?? '—'})
                          </span>
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-slate-300 text-center">
                          {t.entry_price != null ? `$${t.entry_price.toFixed(2)}` : '---'}
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-center">
                          {t.tp_price != null || t.sl_price != null ? (
                            <div className="flex flex-col text-[7px] sm:text-[8px] tracking-tighter uppercase">
                              <span className="text-emerald-500/60">TP: ${t.tp_price != null ? t.tp_price.toFixed(2) : '---'}</span>
                              <span className="text-red-500/60">SL: ${t.sl_price != null ? t.sl_price.toFixed(2) : '---'}</span>
                            </div>
                          ) : <span className="text-slate-700 italic text-[7px] sm:text-[9px]">Dynamic</span>}
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-center">
                          {isOpen ? (
                            <span className="text-purple-400 animate-pulse font-black text-[8px] sm:text-[9px]">PENDING</span>
                          ) : (
                            <span className="text-[8px] sm:text-[10px] text-slate-400">
                              {t.exit_price != null ? `$${t.exit_price.toFixed(2)}` : 'CLOSED'}
                              {t.exit_reason && <span className="ml-1 text-[7px] text-slate-600 uppercase">{t.exit_reason}</span>}
                            </span>
                          )}
                          {/* SIM-ONLY: no close action. Disabled button w/ tooltip. */}
                          <button
                            disabled
                            title="Shadow resolves via sim only"
                            className="ml-1 sm:ml-2 bg-slate-800/50 text-slate-600 border border-slate-700/50 px-1 sm:px-2 py-0.5 rounded text-[7px] sm:text-[8px] font-black cursor-not-allowed"
                          >
                            X
                          </button>
                        </td>
                        <td className="px-1.5 sm:px-2 py-1 sm:py-1.5 text-right font-black text-[8px] sm:text-[10px]">{pnlDisplay}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}