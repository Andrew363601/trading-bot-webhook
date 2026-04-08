import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Activity, Zap, TrendingUp, ShieldAlert, RefreshCcw, Database, BarChart3, Clock, Power } from 'lucide-react';

const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const CRON_SECRET = "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

export default function Dashboard() {
  const [supabase, setSupabase] = useState(null);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [optLoading, setOptLoading] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    setSupabase(client);
  }, []);

  useEffect(() => {
    if (supabase) {
      fetchData();
      const int = setInterval(fetchData, 10000);
      return () => clearInterval(int);
    }
  }, [supabase]);

  const fetchData = async () => {
    try {
      const { data: strat } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
      setActiveStrategy(strat);
      const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(10);
      setTradeLogs(logs || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  // --- NEW: TOGGLE EXECUTION MODE ---
  const toggleExecutionMode = async () => {
    if (!activeStrategy) return;
    const newMode = activeStrategy.execution_mode === 'LIVE' ? 'PAPER' : 'LIVE';
    
    try {
      const { error } = await supabase
        .from('strategy_config')
        .update({ execution_mode: newMode })
        .eq('id', activeStrategy.id);
        
      if (error) throw error;
      
      setActiveStrategy(prev => ({ ...prev, execution_mode: newMode }));
      setMsg(`System shifted to ${newMode} trading.`);
      setTimeout(() => setMsg(''), 4000);
    } catch (err) {
      setError(`Failed to toggle mode: ${err.message}`);
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

  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center font-mono text-indigo-500">Establishing Nexus...</div>;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-6 font-sans">
      <header className="max-w-7xl mx-auto flex justify-between items-center mb-10 border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Coherence</h1>
        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest"><Database size={12} /> wsrioyxzhxxrtzjncfvn</div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-8 shadow-2xl relative overflow-hidden group">
            
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-slate-500 text-[10px] font-black uppercase flex items-center gap-2">
                <Activity size={12} className="text-indigo-400" /> Vector State
              </h3>
              
              {/* --- TOGGLE BUTTON --- */}
              {activeStrategy && (
                <button 
                  onClick={toggleExecutionMode}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all ${activeStrategy.execution_mode === 'LIVE' ? 'bg-red-500/20 text-red-400 border border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.2)]' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}
                >
                  <Power size={10} className={activeStrategy.execution_mode === 'LIVE' ? 'animate-pulse' : ''} />
                  {activeStrategy.execution_mode || 'PAPER'}
                </button>
              )}
            </div>

            {activeStrategy ? (
              <div className="space-y-6">
                <div className="text-2xl font-black text-white italic tracking-tighter uppercase leading-tight">{activeStrategy.strategy}</div>
                <div className="text-indigo-400 font-mono text-[10px] uppercase font-bold tracking-widest">v{activeStrategy.version} Optimized</div>
                <div className="bg-black/40 border border-slate-800 rounded-xl p-4">
                  <pre className="text-[10px] font-mono text-cyan-400/90 leading-relaxed overflow-x-auto">
                    {typeof activeStrategy.parameters === 'string' ? activeStrategy.parameters : JSON.stringify(activeStrategy.parameters, null, 2)}
                  </pre>
                </div>
                <button onClick={triggerOptimizer} disabled={optLoading} className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white rounded-xl font-black flex items-center justify-center gap-3">
                  {optLoading ? <RefreshCcw className="animate-spin" size={18} /> : <TrendingUp size={18} />} Optimize R(ΨC)
                </button>
                {msg && <div className="text-center text-[10px] font-black text-indigo-400 animate-pulse uppercase tracking-widest italic">{msg}</div>}
              </div>
            ) : <div className="py-20 text-center opacity-20 uppercase tracking-[0.5em] text-[10px] italic">Awaiting Sync</div>}
          </div>
          {error && <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-[10px] font-bold uppercase italic"><ShieldAlert size={14} className="inline mr-2" /> {error}</div>}
        </div>

        <div className="lg:col-span-3">
          <div className="bg-slate-900 border border-slate-800 rounded-[2rem] shadow-2xl overflow-hidden h-full">
            <div className="px-8 py-6 border-b border-slate-800 text-[10px] font-black uppercase text-slate-500 flex justify-between items-center">
              <div className="flex items-center gap-2"><BarChart3 size={12} className="text-cyan-400" /> Execution Stream</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-950/20 text-[9px] font-black text-slate-600 uppercase tracking-widest">
                  <tr><th className="px-8 py-5">Horizon</th><th className="px-8 py-5">Asset</th><th className="px-8 py-5 text-right">PnL Result</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-mono text-xs text-slate-400">
                  {tradeLogs.length > 0 ? tradeLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-white/[0.01]">
                      <td className="px-8 py-5 flex items-center gap-2"><Clock size={12} /> {log.exit_time ? new Date(log.exit_time).toLocaleTimeString() : '...'}</td>
                      <td className="px-8 py-5 font-black text-slate-300 uppercase">{log.symbol}</td>
                      <td className={`px-8 py-5 text-right font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{log.pnl?.toFixed(4) || '--'}</td>
                    </tr>
                  )) : <tr><td colSpan="3" className="py-40 text-center opacity-10 uppercase text-xs font-black tracking-[1em]">Scanning Consciousness...</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}