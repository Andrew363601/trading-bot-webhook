import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Activity, Zap, TrendingUp, ShieldAlert, RefreshCcw, Database, BarChart3, Globe } from 'lucide-react';

// --- Configuration ---
// Verified Instance: wsrioyxzhxxrtzjncfvn
const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const CRON_SECRET = "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function Dashboard() {
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [optLoading, setOptLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [debugLog, setDebugLog] = useState(['Initializing Nexus...']);

  const addLog = (m) => setDebugLog(prev => [...prev.slice(-4), m]);

  const fetchData = async () => {
    try {
      addLog("Fetching strategy...");
      const { data: strat, error: stratErr } = await supabase
        .from('strategy_config')
        .select('*')
        .eq('is_active', true)
        .single();
      
      if (stratErr && stratErr.code !== 'PGRST116') throw stratErr;
      
      if (strat && typeof strat.parameters === 'string') {
        try { strat.parameters = JSON.parse(strat.parameters); } catch (e) { addLog("Param parse error"); }
      }
      setActiveStrategy(strat);

      addLog("Fetching trade stream...");
      const { data: logs, error: logsErr } = await supabase
        .from('trade_logs')
        .select('*')
        .order('id', { ascending: false })
        .limit(12);

      if (logsErr) throw logsErr;
      setTradeLogs(logs || []);
      setError(null);
      addLog("Sync Complete.");
    } catch (err) {
      console.error("Dashboard Sync Error:", err.message);
      setError(err.message);
      addLog("Error: " + err.message.substring(0, 20));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const optimize = async () => {
    setOptLoading(true);
    setMsg('AI Researching Resonance...');
    try {
      const res = await fetch('/api/run-gemini-optimizer', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${CRON_SECRET}` 
        }
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || "Optimization failed");
      
      setMsg(r.message || 'Optimization Complete.');
      fetchData();
    } catch (e) { 
      setMsg('Error: ' + e.message); 
    } finally { 
      setOptLoading(false); 
      setTimeout(() => setMsg(''), 5000); 
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center font-mono text-indigo-500 p-6">
      <RefreshCcw className="animate-spin mb-4" size={32} />
      <div className="tracking-[0.5em] text-xs uppercase animate-pulse mb-8">Establishing Nexus...</div>
      <div className="w-full max-w-xs bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-[10px] text-slate-500 space-y-1">
        {debugLog.map((log, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-indigo-600 font-bold opacity-50">[{i}]</span> {log}
          </div>
        ))}
      </div>
      {error && (
        <button onClick={() => window.location.reload()} className="mt-8 text-xs font-black text-red-400 border border-red-400/20 px-4 py-2 rounded-lg hover:bg-red-400/10">
          RETRY CONNECTION
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-12 border-b border-slate-800/50 pb-8">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase tracking-tighter">
            Nexus Coherence
          </h1>
          <p className="flex items-center gap-2 text-slate-500 text-[10px] font-bold uppercase tracking-[0.4em] mt-2">
            <Database size={12} className="text-indigo-500" /> Instance: wsrioyxzhxxrtzjncfvn
          </p>
        </div>
        <div className="flex gap-4 mt-6 md:mt-0">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl px-6 py-3 flex items-center gap-3 shadow-inner">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 italic">Bybit Linked</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Left: AI Strategy Control Panel */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-[2.5rem] p-8 shadow-2xl relative overflow-hidden group">
            <div className="absolute -top-10 -right-10 opacity-5 group-hover:opacity-10 transition-opacity pointer-events-none">
              <Zap size={220} />
            </div>
            
            <h3 className="text-slate-500 text-[10px] font-black tracking-widest uppercase mb-8 flex items-center gap-2">
              <Activity size={12} className="text-indigo-400" /> Vector Parameters
            </h3>

            {activeStrategy ? (
              <div className="space-y-6 relative z-10">
                <div>
                  <div className="text-3xl font-black text-white italic tracking-tighter uppercase leading-tight">
                    {activeStrategy.strategy}
                  </div>
                  <div className="text-indigo-400 font-mono text-[10px] uppercase font-bold tracking-widest mt-1">
                    Build {activeStrategy.version} Optimized
                  </div>
                </div>

                <div className="bg-black/40 border border-slate-800 rounded-2xl p-5 shadow-inner">
                  <pre className="text-[11px] font-mono text-cyan-400/80 leading-relaxed overflow-x-auto">
                    {JSON.stringify(activeStrategy.parameters, null, 2)}
                  </pre>
                </div>

                <button 
                  onClick={optimize} 
                  disabled={optLoading} 
                  className="w-full py-5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white rounded-2xl font-black transition-all shadow-xl shadow-indigo-600/20 flex items-center justify-center gap-3 active:scale-[0.98]"
                >
                  {optLoading ? <RefreshCcw className="animate-spin" size={18} /> : <TrendingUp size={18} />}
                  {optLoading ? 'AI ANALYZING...' : 'RUN AI OPTIMIZER'}
                </button>
                
                {msg && (
                  <div className="text-center text-[10px] font-black text-indigo-400 animate-pulse uppercase tracking-widest">
                    {msg}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-20 text-center opacity-30 text-xs uppercase italic tracking-widest">No Active Config</div>
            )}
          </div>
        </div>

        {/* Right: Execution Stream */}
        <div className="lg:col-span-3">
          <div className="bg-slate-900 border border-slate-800 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col h-full border-t-cyan-500/20">
            <div className="px-8 py-7 border-b border-slate-800 flex justify-between items-center bg-slate-900/30">
              <h3 className="text-slate-500 text-[10px] font-black tracking-widest uppercase flex items-center gap-2">
                <BarChart3 size={12} className="text-cyan-400" /> Execution Stream
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="text-slate-600 text-[9px] font-black uppercase tracking-widest bg-slate-950/20">
                  <tr>
                    <th className="px-8 py-5">Event Time</th>
                    <th className="px-8 py-5">Asset</th>
                    <th className="px-8 py-5">Status</th>
                    <th className="px-8 py-5 text-right">PnL Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-mono text-xs">
                  {tradeLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-white/[0.01] transition-colors group">
                      <td className="px-8 py-5 text-slate-500 uppercase">
                        {log.exit_time ? new Date(log.exit_time).toLocaleTimeString() : 'In Progress...'}
                      </td>
                      <td className="px-8 py-5 font-black text-sm tracking-tighter uppercase text-slate-300">
                        {log.symbol || 'DOGEUSDT'}
                      </td>
                      <td className="px-8 py-5">
                        <span className={`text-[9px] font-black px-3 py-1 rounded-lg border italic uppercase ${log.side === 'LONG' || log.side === 'Buy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                          {log.side}
                        </span>
                      </td>
                      <td className={`px-8 py-5 text-right font-black text-sm italic tracking-tighter ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {log.pnl != null ? (
                          <span>{log.pnl >= 0 ? '+' : ''}{log.pnl.toFixed(4)}</span>
                        ) : '--'}
                      </td>
                    </tr>
                  ))}
                  {tradeLogs.length === 0 && (
                    <tr>
                      <td colSpan="4" className="py-40 text-center opacity-20 font-black uppercase text-xs italic tracking-[0.5em]">
                        Scanning Field...
                      </td>
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