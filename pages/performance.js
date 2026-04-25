import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { createChart } from 'lightweight-charts';
import { 
  BarChart3, Calendar, Target, TrendingUp, TrendingDown, Clock, BrainCircuit, LineChart, Lightbulb, Layers
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function PerformanceLog() {
  const [isMounted, setIsMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  
  const [allValidTrades, setAllValidTrades] = useState([]);
  
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [strategyFilter, setStrategyFilter] = useState('ALL');
  const [selectedDate, setSelectedDate] = useState(null);
  const [logFilter, setLogFilter] = useState('ALL'); 

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);

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

      const valid = (trades || []).filter(t => {
          if (!t || !t.exit_time) return false;
          if (isNaN(new Date(t.exit_time).getTime())) return false; 
          if (parseFloat(t.pnl || 0) === 0 && t.entry_price === t.exit_price) return false; 
          return true;
      });

      setAllValidTrades(valid);
      setSelectedDate(calendarDays[calendarDays.length - 1]);
    } catch (err) {
      console.error("Performance Fetch Error:", err);
    } finally {
      setLoading(false);
    }
  }, [calendarDays]);

  useEffect(() => { 
      if (isMounted) fetchPerformance(); 
  }, [fetchPerformance, isMounted]);

  const globalFilteredTrades = useMemo(() => {
      return allValidTrades.filter(t => {
          if (assetFilter !== 'ALL' && t.symbol !== assetFilter) return false;
          if (strategyFilter !== 'ALL' && t.strategy_id !== strategyFilter) return false;
          return true;
      });
  }, [allValidTrades, assetFilter, strategyFilter]);

  const chartData = useMemo(() => {
      const data = [];
      let cumulativePnl = 0;
      let lastTime = 0;

      // 🟢 THE FIX: Strictly sort trades chronologically before plotting to prevent Library crash
      const sortedTrades = [...globalFilteredTrades].sort((a, b) => new Date(a.exit_time).getTime() - new Date(b.exit_time).getTime());

      sortedTrades.forEach(t => {
          let safeTime = Math.floor(new Date(t.exit_time).getTime() / 1000);
          if (safeTime <= lastTime) safeTime = lastTime + 1; 
          lastTime = safeTime;
          
          const pnlNum = parseFloat(t.pnl) || 0;
          cumulativePnl += pnlNum;
          data.push({ time: safeTime, value: parseFloat(cumulativePnl.toFixed(2)) });
      });
      return data;
  }, [globalFilteredTrades]);

  const dailyStats = useMemo(() => {
      const stats = {};
      calendarDays.forEach(day => stats[day] = { pnl: 0, trades: 0 });
      
      globalFilteredTrades.forEach(t => {
          const dateStr = new Date(t.exit_time).toISOString().split('T')[0];
          if (stats[dateStr]) {
              stats[dateStr].pnl += (parseFloat(t.pnl) || 0);
              stats[dateStr].trades += 1;
          }
      });
      return stats;
  }, [globalFilteredTrades, calendarDays]);

  useEffect(() => {
    if (!isMounted || !chartContainerRef.current || chartData.length === 0) return;
    
    // Clean up existing chart safely
    if (chartRef.current) {
        try { chartRef.current.remove(); } catch(e){}
        chartRef.current = null;
    }

    // 🟢 THE FIX: Explicit Dimensions to prevent the Zero-Dimension Crash
    const chart = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth || 800,
        height: chartContainerRef.current.clientHeight || 300,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.1)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    });

    const series = chart.addAreaSeries({
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

  const displayLogs = useMemo(() => {
      const reversed = [...globalFilteredTrades].reverse(); 
      return reversed.filter(t => {
          const dateStr = new Date(t.exit_time).toISOString().split('T')[0];
          if (selectedDate && dateStr !== selectedDate) return false;

          const pnl = parseFloat(t.pnl) || 0;
          if (logFilter === 'WIN') return pnl > 0;
          if (logFilter === 'LOSS') return pnl <= 0;
          if (logFilter === 'LONG') return t.side === 'BUY' || t.side === 'LONG';
          if (logFilter === 'SHORT') return t.side === 'SELL' || t.side === 'SHORT';
          return true;
      }).map(t => {
          // 🟢 THE FIX: Defensive typeof shield against null strings crashing .split()
          const originalReason = typeof t.reason === 'string' ? t.reason.split('[EXIT TRIGGER]:')[0].trim() : '';
          return {
              dateStr: new Date(t.exit_time).toISOString().split('T')[0],
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
      
      // 🟢 THE FIX: Safe NaN math
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

  const dailyLogs = globalFilteredTrades.filter(t => new Date(t.exit_time).toISOString().split('T')[0] === selectedDate);
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

        <div className="flex items-center gap-4 bg-slate-900/50 p-2 rounded-2xl border border-white/5">
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
        </div>
      </header>

      <div className="max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl flex flex-col min-h-[300px]">
              <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center justify-between">
                  <span className="flex items-center gap-2"><LineChart size={14}/> Cumulative Equity Curve</span>
                  {chartData.length > 0 && <span className={`text-xs font-mono font-bold ${chartData[chartData.length-1].value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${chartData[chartData.length-1].value.toFixed(2)}</span>}
              </h3>
              {chartData.length > 0 ? (
                  <div ref={chartContainerRef} className="flex-grow w-full relative min-h-[250px]" style={{ height: '300px' }} />
              ) : (
                  <div className="flex-grow flex items-center justify-center text-slate-600 font-mono text-[10px] uppercase tracking-widest">No valid trades to plot</div>
              )}
          </div>
          
          <div className="lg:col-span-1 bg-indigo-500/10 border border-indigo-500/20 rounded-3xl p-6 shadow-2xl flex flex-col gap-4">
             <h3 className="text-[10px] font-black uppercase text-indigo-300 tracking-widest flex items-center gap-2"><Lightbulb size={14}/> Optimizer Insights</h3>
             <p className="text-[12px] text-indigo-200 leading-relaxed font-mono italic">
                 {generateInsights()}
             </p>
             <div className="mt-auto pt-4 border-t border-indigo-500/20">
                 <div className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Filtered Trades Evaluated: <span className="text-white">{globalFilteredTrades.length}</span></div>
             </div>
          </div>
      </div>

      <div className="max-w-[1400px] w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl">
        <h3 className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4 flex items-center gap-2"><Calendar size={14}/> 4-Week Rolling Calendar</h3>
        
        <div className="grid grid-cols-7 gap-2">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(day => (
                <div key={day} className="text-center text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2">{day}</div>
            ))}
            {calendarDays.map((day) => {
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
             
             {displayLogs.map((pipeline, i) => {
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
                             <h4 className="text-[9px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2 mb-1"><BrainCircuit size={10}/> Oracle Rationale</h4>
                             <p className="text-[11px] text-slate-400 italic whitespace-pre-wrap">&quot;{pipeline.reasoning}&quot;</p>
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
             
             {displayLogs.length === 0 && <div className="text-[10px] font-mono text-slate-600 pl-2">No executed trades match these filters.</div>}
          </div>
        </div>
      )}
    </div>
  );
}