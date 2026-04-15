import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  BarChart3, Calendar, Target, TrendingUp, TrendingDown, Clock, BrainCircuit, Server, Crosshair, Zap
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function PerformanceLog() {
  const [dailyStats, setDailyStats] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [detailedPipelines, setDetailedPipelines] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchPerformance = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: trades }, { data: scans }] = await Promise.all([
        supabase.from('trade_logs').select('*').not('exit_price', 'is', null).order('exit_time', { ascending: false }),
        supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(500)
      ]);

      // 1. Group by Day for the Chart
      const groupedByDay = {};
      (trades || []).forEach(trade => {
        const dateStr = new Date(trade.exit_time).toISOString().split('T')[0];
        if (!groupedByDay[dateStr]) groupedByDay[dateStr] = { date: dateStr, pnl: 0, trades: [] };
        groupedByDay[dateStr].pnl += parseFloat(trade.pnl || 0);
        groupedByDay[dateStr].trades.push(trade);
      });

      const chartData = Object.values(groupedByDay).sort((a, b) => new Date(a.date) - new Date(b.date));
      setDailyStats(chartData);

      // Select the most recent day by default if exists
      if (chartData.length > 0 && !selectedDate) {
        setSelectedDate(chartData[chartData.length - 1].date);
      }

      // 2. Stitch Pipelines for the detailed view
      const stitched = (trades || []).map(trade => {
        const tradeTime = new Date(trade.created_at).getTime();
        const relatedScan = (scans || []).find(s => {
          const scanTime = new Date(s.created_at).getTime();
          const timeDiff = tradeTime - scanTime;
          return s.asset === trade.symbol && s.strategy === trade.strategy_id && timeDiff >= 0 && timeDiff < 300000;
        });

        return {
          dateStr: new Date(trade.exit_time).toISOString().split('T')[0],
          timestamp: tradeTime,
          asset: trade.symbol,
          strategy: trade.strategy_id,
          trade: trade,
          scan: relatedScan || null
        };
      });

      setDetailedPipelines(stitched);

    } catch (err) {
      console.error("Performance Fetch Error:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchPerformance();
  }, [fetchPerformance]);

  const maxPnl = Math.max(...dailyStats.map(d => Math.abs(d.pnl)), 1); // Avoid division by zero
  const filteredPipelines = detailedPipelines.filter(p => p.dateStr === selectedDate);

  const totalSelectedPnL = filteredPipelines.reduce((sum, p) => sum + parseFloat(p.trade.pnl || 0), 0);
  const winRate = filteredPipelines.length > 0 
    ? ((filteredPipelines.filter(p => p.trade.pnl > 0).length / filteredPipelines.length) * 100).toFixed(1) 
    : 0;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-6 font-sans flex flex-col gap-6">
      
      <header className="max-w-[1400px] w-full mx-auto flex flex-col md:flex-row justify-between items-center pb-4 border-b border-white/10 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
            <BarChart3 className="text-emerald-400" size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black italic tracking-tighter bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent uppercase">Performance Analytics</h1>
            <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mt-1">Daily PnL & Trade Reports</p>
          </div>
        </div>
      </header>

      {/* PNL HISTOGRAM CHART */}
      <div className="max-w-[1400px] w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl">
        <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-6 flex items-center gap-2"><Calendar size={14}/> 30-Day PnL Distribution</h3>
        
        <div className="h-64 flex items-end gap-2 border-b border-white/10 pb-2 relative">
           {dailyStats.length === 0 ? (
               <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-xs font-mono">Awaiting closed trades...</div>
           ) : dailyStats.map((stat, i) => {
              const heightPercent = (Math.abs(stat.pnl) / maxPnl) * 100;
              const isPositive = stat.pnl >= 0;
              const isSelected = selectedDate === stat.date;
              
              return (
                <div 
                  key={i} 
                  onClick={() => setSelectedDate(stat.date)}
                  className={`flex-1 flex flex-col items-center justify-end cursor-pointer group relative h-full`}
                >
                  <div className="absolute -top-8 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-mono font-black bg-black/80 px-2 py-1 rounded">
                     ${stat.pnl.toFixed(2)}
                  </div>
                  
                  <div 
                    style={{ height: `${heightPercent}%`, minHeight: '4px' }} 
                    className={`w-full max-w-[40px] rounded-t-sm transition-all duration-300 ${
                      isSelected ? (isPositive ? 'bg-emerald-400 shadow-[0_0_15px_-3px_rgba(52,211,153,0.5)]' : 'bg-red-400 shadow-[0_0_15px_-3px_rgba(248,113,113,0.5)]') 
                                 : (isPositive ? 'bg-emerald-500/40 hover:bg-emerald-400/80' : 'bg-red-500/40 hover:bg-red-400/80')
                    }`}
                  />
                  {isSelected && <div className="absolute -bottom-6 text-[9px] font-mono text-white">{stat.date.substring(5)}</div>}
                </div>
              );
           })}
        </div>
      </div>

      {/* DAILY DETAILED REPORT */}
      {selectedDate && (
        <div className="max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          {/* STATS SIDEBAR */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="bg-slate-900/40 border border-white/10 p-5 rounded-3xl">
               <div className="text-[10px] text-slate-500 font-black tracking-widest uppercase mb-4">Date: {selectedDate}</div>
               <div className={`text-3xl font-black font-mono mb-6 ${totalSelectedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {totalSelectedPnL >= 0 ? '+' : ''}${totalSelectedPnL.toFixed(2)}
               </div>
               
               <div className="space-y-3">
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><Target size={12}/> Win Rate</span>
                     <span className="font-mono text-sm">{winRate}%</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingUp size={12}/> Winners</span>
                     <span className="font-mono text-sm text-emerald-400">{filteredPipelines.filter(p => p.trade.pnl > 0).length}</span>
                  </div>
                  <div className="flex justify-between items-center pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingDown size={12}/> Losers</span>
                     <span className="font-mono text-sm text-red-400">{filteredPipelines.filter(p => p.trade.pnl <= 0).length}</span>
                  </div>
               </div>
            </div>
          </div>

          {/* PIPELINE LIST */}
          <div className="lg:col-span-3 space-y-4">
             <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2 pl-2"><Clock size={14}/> Execution Logs</h3>
             
             {filteredPipelines.map((pipeline, i) => {
                const t = pipeline.trade;
                const s = pipeline.scan;
                const isWin = t.pnl > 0;

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
                            <span className={`font-black font-mono text-sm ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>{isWin ? '+' : ''}${t.pnl}</span>
                        </div>
                     </div>

                     <div className="flex flex-col gap-3 pl-2">
                        {/* Oracle Section */}
                        {s && s.telemetry?.oracle_reasoning && (
                          <div className="border-l-2 border-amber-500/30 pl-4 py-1">
                             <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2 mb-1"><BrainCircuit size={10}/> Oracle Rationale</h4>
                             {/* THE FIX HERE AS WELL FOR SAFE MEASURE */}
                             <p className="text-[11px] text-slate-400 italic">&quot;{s.telemetry.oracle_reasoning}&quot;</p>
                          </div>
                        )}
                        
                        {/* Trade Details */}
                        <div className="border-l-2 border-slate-500/30 pl-4 py-1 flex flex-wrap gap-x-6 gap-y-2">
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Entry:</span>
                              <span className="text-[11px] font-mono text-white">${t.entry_price}</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Exit:</span>
                              <span className="text-[11px] font-mono text-white">${t.exit_price}</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500 uppercase tracking-widest">Side:</span>
                              <span className={`text-[11px] font-black uppercase ${t.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side}</span>
                           </div>
                           {t.reason && t.reason.includes('[EXIT TRIGGER]') && (
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
          </div>
        </div>
      )}
    </div>
  );
}