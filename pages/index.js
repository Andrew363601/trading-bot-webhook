import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  Activity, Zap, TrendingUp, ShieldAlert, RefreshCcw, Database, 
  BarChart3, Clock, Power, Cpu, Terminal, ShieldCheck
} from 'lucide-react';

const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const CRON_SECRET = "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function Dashboard() {
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [optLoading, setOptLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false); // UI Lock
  const [msg, setMsg] = useState('');

  const fetchData = async () => {
    if (isToggling) return; // Prevent reversion during DB update

    try {
      const { data: strat } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
      if (strat && typeof strat.parameters === 'string') {
        try { strat.parameters = JSON.parse(strat.parameters); } catch(e) {}
      }
      setActiveStrategy(strat);

      const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(12);
      setTradeLogs(logs || []);
    } catch (e) { 
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, [isToggling]);

  const toggleExecutionMode = async () => {
    if (!activeStrategy || isToggling) return;
    
    setIsToggling(true);
    const oldMode = activeStrategy.execution_mode;
    const newMode = oldMode === 'LIVE' ? 'PAPER' : 'LIVE';
    
    // Optimistic Update
    setActiveStrategy(prev => ({ ...prev, execution_mode: newMode }));
    setMsg(`Requesting Shift to ${newMode}...`);

    try {
      const { error } = await supabase
        .from('strategy_config')
        .update({ execution_mode: newMode })
        .eq('id', activeStrategy.id);
        
      if (error) throw error;
      
      setMsg(`Nexus System: ${newMode} Mode Actualized.`);
      setTimeout(() => {
        setIsToggling(false);
        setMsg('');
      }, 4000); // 4s buffer for DB consistency

    } catch (err) {
      setActiveStrategy(prev => ({ ...prev, execution_mode: oldMode }));
      setError(`Toggle Fault: ${err.message}`);
      setIsToggling(false);
    }
  };

  const triggerOptimizer = async () => {
    setOptLoading(true);
    setMsg('AI Resonance Shift in progress...');
    try {
      const res = await fetch('/api/run-gemini-optimizer', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET}` 
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(data.message);
      fetchData();
    } catch (err) {
      setMsg('Fault: ' + err.message);
    } finally {
      setOptLoading(false);
      setTimeout(() => setMsg(''), 6000);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center font-mono text-indigo-500">
      <RefreshCcw className="animate-spin mb-4" size={32} />
      <div className="tracking-[0.5em] text-[10px] uppercase animate-pulse">Syncing Nexus...</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 md:p-10 font-sans">
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-12 border-b border-white/5 pb-10">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 via-cyan-400 to-indigo-400 bg-clip-text text-transparent uppercase leading-none">
            Nexus Coherence
          </h1>
          <div className="flex items-center gap-4 mt-4 text-slate-500 text-[10px] font-black uppercase tracking-[0.4em] italic">
             <Database size={12} className="text-indigo-500" /> Instance: wsrioyxzhxxrtzjncfvn
          </div>
        </div>
        
        <div className="hidden md:flex items-center gap-6 bg-white/5 p-4 rounded-3xl border border-white/10 backdrop-blur-xl">
           <div className="text-right">
             <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Network Status</div>
             <div className="text-emerald-400 text-xs font-black uppercase flex items-center gap-2 justify-end">
               <span className="h-1.5 w-1.5 bg-emerald-500 rounded-full animate-pulse"></span> Synchronized
             </div>
           </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Left Panel */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-slate-900/80 border border-white/10 rounded-[2.5rem] p-8 shadow-2xl backdrop-blur-md relative overflow-hidden">
            <div className="flex justify-between items-center mb-10">
              <h3 className="text-slate-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                <Cpu size={14} className="text-indigo-400" /> Vector State
              </h3>
              
              <button 
                onClick={toggleExecutionMode}
                disabled={isToggling}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-[10px] font-black uppercase tracking-widest transition-all duration-500 border ${
                  activeStrategy?.execution_mode === 'LIVE' 
                    ? 'bg-red-500/20 text-red-400 border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.4)]' 
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                }`}
              >
                <Power size={12} className={activeStrategy?.execution_mode === 'LIVE' ? 'animate-pulse' : ''} />
                {activeStrategy?.execution_mode || 'PAPER'}
              </button>
            </div>

            {activeStrategy ? (
              <div className="space-y-8">
                <div>
                  <div className="text-3xl font-black text-white italic tracking-tighter uppercase leading-tight">
                    {activeStrategy.strategy}
                  </div>
                  <div className="text-indigo-400 font-mono text-[10px] uppercase font-bold tracking-[0.2em] mt-2 flex items-center gap-2 italic">
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.5)]"></span>
                    v{activeStrategy.version} Optimized
                  </div>
                </div>

                <div className="bg-black/60 border border-white/5 rounded-2xl p-5 shadow-inner">
                  <div className="text-[9px] font-black text-slate-600 uppercase mb-4 tracking-widest flex items-center gap-2">
                    <Terminal size={10} /> Parameters
                  </div>
                  <pre className="text-[10px] font-mono text-cyan-400/90 leading-relaxed overflow-x-auto">
                    {JSON.stringify(activeStrategy.parameters, null, 2)}
                  </pre>
                </div>

                <button 
                  onClick={triggerOptimizer} 
                  disabled={optLoading} 
                  className="w-full py-5 bg-gradient-to-br from-indigo-600 to-indigo-800 hover:from-indigo-500 hover:to-indigo-700 disabled:from-slate-800 disabled:to-slate-900 text-white rounded-2xl font-black transition-all flex items-center justify-center gap-3 shadow-xl active:scale-[0.98] border border-white/5"
                >
                  {optLoading ? <RefreshCcw className="animate-spin" size={18} /> : <Zap size={18} />}
                  <span className="uppercase text-xs tracking-widest">Optimize Nexus</span>
                </button>
                
                {msg && <div className="text-center text-[10px] font-black text-indigo-400 animate-pulse uppercase tracking-widest italic bg-indigo-500/5 py-3 rounded-xl border border-indigo-500/10">{msg}</div>}
              </div>
            ) : <div className="py-20 text-center opacity-10 uppercase tracking-[0.5em] text-[10px] font-black">Awaiting Sync...</div>}
          </div>

          {error && (
            <div className="p-5 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-start gap-4 text-red-400 text-[10px] font-bold uppercase italic tracking-tighter">
              <ShieldAlert size={16} className="shrink-0" /> {error}
            </div>
          )}
        </div>

        {/* Right Panel */}
        <div className="lg:col-span-3 h-full">
          <div className="bg-slate-900/50 border border-white/10 rounded-[3rem] shadow-2xl overflow-hidden min-h-[500px] flex flex-col backdrop-blur-xl">
            <div className="px-10 py-8 border-b border-white/5 flex justify-between items-center bg-slate-900/40">
              <h3 className="text-slate-500 text-[10px] font-black tracking-[0.3em] uppercase flex items-center gap-3">
                <BarChart3 size={14} className="text-cyan-400" /> Execution Stream
              </h3>
            </div>

            <div className="overflow-x-auto grow">
              <table className="w-full text-left">
                <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-[0.2em]">
                  <tr>
                    <th className="px-10 py-6">Timestamp</th>
                    <th className="px-10 py-6">Asset Vector</th>
                    <th className="px-10 py-6">Mode</th>
                    <th className="px-10 py-6">Side</th>
                    <th className="px-10 py-6 text-right">PnL Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                  {tradeLogs.length > 0 ? tradeLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                      <td className="px-10 py-6 text-slate-500 flex items-center gap-2">
                        <Clock size={12} className="opacity-40 group-hover:text-indigo-400" />
                        {log.exit_time ? new Date(log.exit_time).toLocaleTimeString() : '...'}
                      </td>
                      <td className="px-10 py-6 font-black text-slate-200 uppercase tracking-tighter">{log.symbol}</td>
                      <td className="px-10 py-6">
                        <span className={`text-[8px] font-black px-2 py-0.5 rounded border uppercase tracking-tighter ${
                          log.execution_mode === 'LIVE' ? 'text-red-400 border-red-500/30 bg-red-500/5 shadow-[0_0_10px_rgba(239,68,68,0.1)]' : 'text-slate-500 border-white/10 bg-white/5'
                        }`}>
                          {log.execution_mode || 'PAPER'}
                        </span>
                      </td>
                      <td className="px-10 py-6">
                        <span className={`px-3 py-1 rounded-xl text-[9px] font-black uppercase italic border ${
                          log.side === 'LONG' || log.side === 'Buy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}>
                          {log.side}
                        </span>
                      </td>
                      <td className={`px-10 py-6 text-right font-black text-sm ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {log.pnl != null ? (log.pnl >= 0 ? '+' : '') + log.pnl.toFixed(4) : '--'}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="py-40 text-center opacity-10 uppercase text-xs font-black tracking-[1em] italic">Scanning Consciousness...</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}