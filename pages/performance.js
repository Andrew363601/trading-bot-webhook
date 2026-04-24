import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { createChart } from 'lightweight-charts';
import { 
  BarChart3, Calendar, Target, TrendingUp, TrendingDown, Clock, BrainCircuit, LineChart, Lightbulb
} from 'lucide-react';

// 🟢 THE FIX: Safe process.env wrapper to prevent browser-side ReferenceErrors
const getEnv = (key, fallback) => {
    if (typeof process !== 'undefined' && process.env) return process.env[key] || fallback;
    return fallback;
};

const SUPABASE_URL = getEnv('NEXT_PUBLIC_SUPABASE_URL', "https://wsrioyxzhxxrtzjncfvn.supabase.co");
const SUPABASE_ANON_KEY = getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function PerformanceLog() {
  const [isMounted, setIsMounted] = useState(false);
  
  const [dailyStats, setDailyStats] = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [detailedPipelines, setDetailedPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [logFilter, setLogFilter] = useState('ALL'); 
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
      setIsMounted(true);
  }, []);

  const calendarDays = useMemo(() => {
    return [...Array(28)].map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (27 - i));
      return d.toISOString().split('T')[0];
    });
  }, []);

  const fetchPerformance = useCallback(async () => {
    setLoading(true);
    try {
      const { data: trades } = await supabase.from('trade_logs').select('*').not('exit_price', 'is', null).order('exit_time', { ascending: true }); 

      const statsMap = {};
      calendarDays.forEach(day => statsMap[day] = { date: day, pnl: 0, trades: 0 });

      // 🟢 THE FIX: Strict Date Validation Shield prevents NaN from crashing the chart
      const validTrades = (trades || []).filter(t => {
          if (!t?.exit_time) return false;
          const parsedTime = new Date(t.exit_time).getTime();
          if (isNaN(parsedTime)) return false; // Block corrupted date strings
          if (parseFloat(t?.pnl || 0) === 0 && t?.entry_price === t?.exit_price) return false; // Block stale limits
          return true;
      });

      const rawChartData = validTrades.map(trade => ({
          time: Math.floor(new Date(trade.exit_time).getTime() / 1000),
          pnl: parseFloat(trade.pnl || 0)
      }));
      
      rawChartData.sort((a, b) => a.time - b.time);

      const uniqueChartData = [];
      let cumulativePnl = 0;
      let lastTime = 0;

      rawChartData.forEach(data => {
          let safeTime = data.time;
          if (safeTime <= lastTime) safeTime = lastTime + 1; // Strict time-stepper prevents duplicates
          lastTime = safeTime;
          
          if (!isNaN(safeTime) && !isNaN(data.pnl)) {
              cumulativePnl += data.pnl;
              uniqueChartData.push({ time: safeTime, value: parseFloat(cumulativePnl.toFixed(2)) });
          }
      });

      // Populate Calendar Math
      validTrades.forEach(trade => {
        const dateStr = new Date(trade.exit_time).toISOString().split('T')[0];
        if (statsMap[dateStr]) {
            statsMap[dateStr].pnl += parseFloat(trade.pnl || 0);
            statsMap[dateStr].trades += 1;
        }
      });

      setDailyStats(statsMap);
      setSelectedDate(prev => prev || calendarDays[calendarDays.length - 1]);

      if (seriesRef.current && uniqueChartData.length > 0) {
          seriesRef.current.setData(uniqueChartData);
      }

      const stitched = [...validTrades].reverse().map(trade => {
        const originalReason = trade?.reason?.split('[EXIT TRIGGER]:')[0]?.trim();
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
  }, [calendarDays]);

  useEffect(() => { 
      if (isMounted) fetchPerformance(); 
  }, [fetchPerformance, isMounted]);

  useEffect(() => {
    if (!chartContainerRef.current || !isMounted) return;
    
    const chart = createChart(chartContainerRef.current, {
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.1)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
        autoSize: true,
    });

    const series = chart.addAreaSeries({
        lineColor: '#3b82f6',
        topColor: 'rgba(59, 130, 246, 0.4)',
        bottomColor: 'rgba(59, 130, 246, 0.0)',
        lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
        if(chartContainerRef.current) {
            chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });
        }
    };
    
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
        resizeObserver.disconnect();
        chart.remove();
    };
  }, [isMounted]);

  const rawFilteredPipelines = detailedPipelines?.filter(p => p?.dateStr === selectedDate) || [];
  const filteredPipelines = rawFilteredPipelines?.filter(p => {
      if (!p?.trade) return false;
      const pnl = parseFloat(p.trade.pnl || 0);
      if (logFilter === 'WIN') return pnl > 0;
      if (logFilter === 'LOSS') return pnl <= 0;
      if (logFilter === 'LONG') return p.trade.side === 'BUY' || p.trade.side === 'LONG';
      if (logFilter === 'SHORT') return p.trade.side === 'SELL' || p.trade.side === 'SHORT';
      return true;
  }) || [];

  const totalSelectedPnL = rawFilteredPipelines.reduce((sum, p) => sum + parseFloat(p?.trade?.pnl || 0), 0);
  const winRate = rawFilteredPipelines.length > 0 
    ? ((rawFilteredPipelines.filter(p => parseFloat(p?.trade?.pnl || 0) > 0).length / rawFilteredPipelines.length) * 100).toFixed(1) 
    : 0;

  const generateInsights = () => {
      if (!detailedPipelines || detailedPipelines.length < 5) return "Accumulating telemetry. Minimum 5 trades required to generate reliable optimization insights.";
      
      const wins = detailedPipelines.filter(p => parseFloat(p?.trade?.pnl || 0) > 0);
      const losses = detailedPipelines.filter(p => parseFloat(p?.trade?.pnl || 0) <= 0);
      
      const avgWin = wins.length > 0 ? wins.reduce((sum, p) => sum + parseFloat(p?.trade?.pnl || 0), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, p) => sum + parseFloat(p?.trade?.pnl || 0), 0) / losses.length) : 0;
      
      const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'Infinity';
      const globalWinRate = ((wins.length / detailedPipelines.length) * 100).toFixed(1);

      if (profitFactor !== 'Infinity' && parseFloat(profitFactor) < 1.0 && globalWinRate > 50) {
          return `Negative Skew Detected: Win rate is healthy (${globalWinRate}%), but Average Loss ($${avgLoss.toFixed(2)}) exceeds Average Win ($${avgWin.toFixed(2)}). Consider tightening your SL Tripwire or trailing stops faster to preserve capital.`;
      } else if (globalWinRate < 40 && profitFactor !== 'Infinity' && parseFloat(profitFactor) > 1.5) {
          return `Low Strike Rate / High Reward: You are getting stopped out frequently (${globalWinRate}% Win Rate), but when you win, you win big (PF: ${profitFactor}). Consider widening your initial Stop Loss to avoid liquidity wicks.`;
      } else if (profitFactor !== 'Infinity' && parseFloat(profitFactor) > 1.5 && globalWinRate >= 50) {
          return `Optimal Structure Maintained: System is highly profitable with a Profit Factor of ${profitFactor}. Maintain current tripwire settings. Consider scaling up base contract sizes dynamically.`;
      } else {
          return `System Stable: Win Rate is ${globalWinRate}% with an Average Win of $${avgWin.toFixed(2)}. Monitor market regimes before adjusting tripwires.`;
      }
  };

  if (!isMounted) return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center text-indigo-500 font-mono tracking-widest uppercase">
       <BarChart3 className="animate-pulse mb-4" size={32} />
       Syncing Telemetry...
    </div>
  );

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

      <div className="max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl flex flex-col min-h-[300px]">
              <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center gap-2"><LineChart size={14}/> Cumulative Equity Curve</h3>
              <div ref={chartContainerRef} className="flex-grow w-full relative" />
          </div>
          
          <div className="lg:col-span-1 bg-indigo-500/10 border border-indigo-500/20 rounded-3xl p-6 shadow-2xl flex flex-col gap-4">
             <h3 className="text-[10px] font-black uppercase text-indigo-300 tracking-widest flex items-center gap-2"><Lightbulb size={14}/> Optimizer Insights</h3>
             <p className="text-[12px] text-indigo-200 leading-relaxed font-mono italic">
                 {generateInsights()}
             </p>
             <div className="mt-auto pt-4 border-t border-indigo-500/20">
                 <div className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Total Valid Trades: <span className="text-white">{detailedPipelines?.length || 0}</span></div>
             </div>
          </div>
      </div>

      <div className="max-w-[1400px] w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl">
        <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center gap-2"><Calendar size={14}/> 4-Week Rolling Calendar</h3>
        
        <div className="grid grid-cols-7 gap-2">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(day => (
                <div key={day} className="text-center text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2">{day}</div>
            ))}
            {calendarDays?.map((day, i) => {
                const stat = dailyStats[day];
                const pnl = parseFloat(stat?.pnl || 0);
                const isSelected = selectedDate === day;
                const hasTrades = (stat?.trades || 0) > 0;
                
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
                     <span className="font-mono text-sm text-emerald-400">{rawFilteredPipelines?.filter(p => parseFloat(p?.trade?.pnl || 0) > 0).length || 0}</span>
                  </div>
                  <div className="flex justify-between items-center pb-2">
                     <span className="text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1"><TrendingDown size={12}/> Losers</span>
                     <span className="font-mono text-sm text-red-400">{rawFilteredPipelines?.filter(p => parseFloat(p?.trade?.pnl || 0) <= 0).length || 0}</span>
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
             
             {filteredPipelines?.map((pipeline, i) => {
                const t = pipeline?.trade;
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
                             <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2 mb-1"><BrainCircuit size={10}/> Oracle Rationale</h4>
                             <p className="text-[11px] text-slate-400 italic">&quot;{pipeline.reasoning}&quot;</p>
                          </div>
                        )}
                        
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
             
             {(!filteredPipelines || filteredPipelines.length === 0) && <div className="text-[10px] font-mono text-slate-600 pl-2">No executed trades match these filters.</div>}
          </div>
        </div>
      )}
    </div>
  );
}