import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  BarChart3, Calendar, Target, TrendingUp, TrendingDown, Clock, BrainCircuit
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function PerformanceLog() {
  const [dailyStats, setDailyStats] = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [detailedPipelines, setDetailedPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Execution Log Filters
  const [logFilter, setLogFilter] = useState('ALL'); // ALL, WIN, LOSS, LONG, SHORT

  // Generate last 28 days for Calendar Grid
  const calendarDays = [...Array(28)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (27 - i));
    return d.toISOString().split('T')[0];
  });

  const fetchPerformance = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: trades }, { data: scans }] = await Promise.all([
        supabase.from('trade_logs').select('*').not('exit_price', 'is', null).order('exit_time', { ascending: false }),
        supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(500)
      ]);

      const statsMap = {};
      calendarDays.forEach(day => statsMap[day] = { date: day, pnl: 0, trades: 0 });

      (trades || []).forEach(trade => {
        const dateStr = new Date(trade.exit_time).toISOString().split('T')[0];
        if (statsMap[dateStr]) {
            statsMap[dateStr].pnl += parseFloat(trade.pnl || 0);
            statsMap[dateStr].trades += 1;
        }
      });

      setDailyStats(statsMap);
      if (!selectedDate) setSelectedDate(calendarDays[calendarDays.length - 1]);

      const stitched = (trades || []).map(trade => {
        const originalReason = trade.reason?.split('[EXIT TRIGGER]:')[0]?.trim();
        return {
          dateStr: new Date(trade.exit_time).toISOString().split('T')[0],
          timeStr: new Date(trade.exit_time).toLocaleTimeString(),
          asset: trade.symbol,
          strategy: trade.strategy_id,
          trade: trade,
          reasoning: originalReason
        };
      });

      setDetailedPipelines(stitched);
    } catch (err) {
      console.error("Performance Fetch Error:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { fetchPerformance(); }, [fetchPerformance]);

  const rawFilteredPipelines = detailedPipelines.filter(p => p.dateStr === selectedDate);
  const filteredPipelines = rawFilteredPipelines.filter(p => {
      if (logFilter === 'WIN') return p.trade.pnl > 0;
      if (logFilter === 'LOSS') return p.trade.pnl <= 0;
      if (logFilter === 'LONG') return p.trade.side === 'BUY' || p.trade.side === 'LONG';
      if (logFilter === 'SHORT') return p.trade.side === 'SELL' || p.trade.side === 'SHORT';
      return true;
  });

  const totalSelectedPnL = rawFilteredPipelines.reduce((sum, p) => sum + parseFloat(p.trade.pnl || 0), 0);
  const winRate = rawFilteredPipelines.length > 0 
    ? ((rawFilteredPipelines.filter(p => p.trade.pnl > 0).length / rawFilteredPipelines.length) * 100).toFixed(1) 
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
            <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mt-1">Daily ROI & Execution Ledger</p>
          </div>
        </div>
      </header>

      {/* NEW CALENDAR GRID */}
      <div className="max-w-[1400px] w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl">
        <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center gap-2"><Calendar size={14}/> 4-Week Rolling Calendar</h3>
        
        <div className="grid grid-cols-7 gap-2">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(day => (
                <div key={day} className="text-center text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2">{day}</div>
            ))}
            {calendarDays.map((day, i) => {
                const stat = dailyStats[day];
                const pnl = stat?.pnl || 0;
                const isSelected = selectedDate === day;
                const hasTrades = stat?.trades > 0;
                
                return (
                    <button 
                        key={day} 
                        onClick={() => setSelectedDate(day)}
                        className={`h-20 rounded-xl p-2 flex flex-col justify-between items-start transition-all border ${
                            isSelected ? 'bg-slate-800 border-indigo-500 shadow-[0_0_15px_-3px_rgba(99,102,241,0.4)]' : 
                            hasTrades ? 'bg-slate-900 border-white/5 hover:bg-slate-800' : 'bg-black/20 border-transparent opacity-50 hover:bg-white/5'
                        }`}
                    >
                        <span className={`text-[10px] font-mono font-bold ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`}>{day.substring(5)}</span>
                        {hasTrades && (
                            <span className={`text-[12px] font-black font-mono w-full text-right ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
      </div>

      {/* DAILY DETAILED REPORT */}
      {selectedDate && (
        <div className="max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
          
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
                     <span className="font-mono text-sm text-emerald-400">{rawFilteredPipelines.filter(p => p.trade.pnl > 0).length}</span>
                  </div>
                  <div className="flex justify-between items-center pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingDown size={12}/> Losers</span>
                     <span className="font-mono text-sm text-red-400">{rawFilteredPipelines.filter(p => p.trade.pnl <= 0).length}</span>
                  </div>
               </div>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-4">
             <div className="flex items-center justify-between pl-2">
                 <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Clock size={14}/> Execution Logs</h3>
                 <div className="flex gap-2">
                     {['ALL', 'WIN', 'LOSS', 'LONG', 'SHORT'].map(f => (
                         <button 
                            key={f} 
                            onClick={() => setLogFilter(f)} 
                            className={`text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-lg border ${logFilter === f ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}
                         >
                            {f}
                         </button>
                     ))}
                 </div>
             </div>
             
             {filteredPipelines.map((pipeline, i) => {
                const t = pipeline.trade;
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
                            <span className="text-[10px] text-slate-500 font-mono">{pipeline.timeStr}</span>
                            <span className={`font-black font-mono text-sm ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>{isWin ? '+' : ''}${t.pnl}</span>
                        </div>
                     </div>

                     <div className="flex flex-col gap-3 pl-2">
                        {pipeline.reasoning && (
                          <div className="border-l-2 border-amber-500/30 pl-4 py-1">
                             <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2 mb-1"><BrainCircuit size={10}/> Oracle Rationale</h4>
                             <p className="text-[11px] text-slate-400 italic">&quot;{pipeline.reasoning}&quot;</p>
                          </div>
                        )}
                        
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
             
             {filteredPipelines.length === 0 && <div className="text-[10px] font-mono text-slate-600 pl-2">No executed trades match these filters.</div>}
          </div>
        </div>
      )}
    </div>
  );
}