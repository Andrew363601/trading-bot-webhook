import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  Activity, 
  Zap, 
  TrendingUp, 
  ShieldAlert, 
  RefreshCcw, 
  Database, 
  BarChart3, 
  Clock,
  ChevronRight,
  Terminal
} from 'lucide-react';

// --- Configuration ---
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
  const [msg, setMsg] = useState('');

  const fetchData = async () => {
    try {
      const { data: strat, error: stratErr } = await supabase
        .from('strategy_config').select('*').eq('is_active', true).single();
      if (stratErr && stratErr.code !== 'PGRST116') throw stratErr;
      
      if (strat && typeof strat.parameters === 'string') {
        try { strat.parameters = JSON.parse(strat.parameters); } catch (e) { console.error("JSON Parse Error", e); }
      }
      setActiveStrategy(strat);

      const { data: logs, error: logsErr } = await supabase
        .from('trade_logs').select('*').order('id', { ascending: false }).limit(15);
      if (logsErr) throw logsErr;
      setTradeLogs(logs || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  /**
   * R(ΨC) OPTIMIZATION HANDLER
   * Performs AI logic in-browser to leverage auto-auth.
   */
  const optimize = async () => {
    setOptLoading(true);
    setMsg('AI Auditing Consciousness Field...');
    
    try {
      const isColdStart = tradeLogs.length === 0;
      const systemPrompt = `Act as an elite institutional quantitative researcher. Optimize 'coherence_threshold' (0.5 to 0.85). 
      CONTEXT: ${isColdStart ? 'COLD START. Shift to "Discovery Mode" (threshold ~0.58).' : 'ANALYSIS. Adjust based on PnL.'}
      Respond ONLY with valid JSON.`;

      const userQuery = `Current Parameters: ${JSON.stringify(activeStrategy?.parameters)}. History: ${isColdStart ? 'EMPTY' : JSON.stringify(tradeLogs)}`;

      const apiKey = ""; 
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

      const aiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userQuery }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { 
            responseMimeType: "application/json", 
            temperature: 0.1 
          }
        })
      });

      if (!aiResponse.ok) {
        const errorJson = await aiResponse.json().catch(() => ({}));
        throw new Error(`AI Gateway Fault: ${errorJson.error?.message || aiResponse.statusText || 'Connection Rejected'}`);
      }
      
      const aiResult = await aiResponse.json();
      let aiText = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!aiText) throw new Error("AI returned empty resonance matrix.");

      // Clean logic to ensure strictly valid JSON
      aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
      const newParams = JSON.parse(aiText);

      const currentVer = parseFloat(activeStrategy?.version || "1.0");
      const nextVer = (currentVer + 0.1).toFixed(1);

      // Commit to Secure API
      const commitRes = await fetch('/api/run-gemini-optimizer', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${CRON_SECRET}` 
        },
        body: JSON.stringify({ 
            parameters: newParams,
            version: nextVer
        })
      });

      const commitData = await commitRes.json();
      if (!commitRes.ok) throw new Error(commitData.error || "Commit Failed");
      
      setMsg(commitData.message);
      fetchData(); 
    } catch (err) {
      console.error("Optimization Failure:", err);
      setMsg('Fault: ' + err.message);
    } finally {
      setOptLoading(false);
      setTimeout(() => setMsg(''), 8000);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center font-mono text-indigo-500">
      <RefreshCcw className="animate-spin mb-4" size={32} />
      <div className="tracking-[0.5em] text-[10px] uppercase animate-pulse">Synchronizing Nexus...</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 md:p-10 font-sans selection:bg-indigo-500/30">
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-16 border-b border-slate-800/50 pb-10">
        <div>
          <h1 className="text-5xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 via-cyan-400 to-indigo-400 bg-clip-text text-transparent uppercase leading-none">
            Nexus Coherence
          </h1>
          <div className="flex items-center gap-4 mt-4">
             <p className="flex items-center gap-2 text-slate-500 text-[10px] font-bold uppercase tracking-[0.4em] italic">
               <Database size={12} className="text-indigo-500" /> Instance: wsrioyxzhxxrtzjncfvn
             </p>
             <div className="h-px w-8 bg-slate-800"></div>
             <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/80 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                Quant Engine Live
             </p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-10">
        <div className="lg:col-span-1 space-y-8">
          <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-10 shadow-2xl relative overflow-hidden group">
            <h3 className="text-slate-500 text-[10px] font-black tracking-[0.3em] uppercase mb-10 flex items-center gap-2">
              <Activity size={14} className="text-indigo-400" /> Vector Matrix
            </h3>

            {activeStrategy ? (
              <div className="space-y-8 relative z-10">
                <div>
                  <div className="text-4xl font-black text-white italic tracking-tighter uppercase leading-tight">
                    {activeStrategy.strategy}
                  </div>
                  <div className="text-indigo-400 font-mono text-[10px] uppercase font-bold tracking-widest mt-2 flex items-center gap-2 italic">
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full"></span>
                    Version {activeStrategy.version} Optimized
                  </div>
                </div>

                <div className="bg-black/60 border border-slate-800 rounded-3xl p-6 shadow-inner">
                  <div className="text-[9px] font-black text-slate-600 uppercase mb-5 tracking-[0.2em]">Logic Parameters</div>
                  <pre className="text-[11px] font-mono text-cyan-400/90 leading-relaxed overflow-x-auto custom-scrollbar">
                    {JSON.stringify(activeStrategy.parameters, null, 2)}
                  </pre>
                </div>

                <button 
                  onClick={optimize} 
                  disabled={optLoading} 
                  className="w-full py-6 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white rounded-[1.5rem] font-black transition-all flex items-center justify-center gap-3 active:scale-[0.97] uppercase text-xs"
                >
                  {optLoading ? <RefreshCcw className="animate-spin" size={20} /> : <TrendingUp size={20} />}
                  {optLoading ? 'AI SYNCING...' : 'Optimize R(ΨC) Loop'}
                </button>
                
                {msg && <div className="text-center text-[10px] font-black text-indigo-400 animate-pulse uppercase tracking-widest bg-indigo-500/5 py-3 rounded-2xl border border-indigo-500/10 italic shadow-inner">{msg}</div>}
              </div>
            ) : <div className="py-24 text-center opacity-20 uppercase tracking-[0.5em] italic text-[10px]">Awaiting Link...</div>}
          </div>
        </div>

        <div className="lg:col-span-3">
          <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] shadow-2xl overflow-hidden h-full border-t-indigo-500/10">
            <div className="px-10 py-8 border-b border-slate-800 flex justify-between items-center bg-slate-900/40">
              <h3 className="text-slate-500 text-[10px] font-black tracking-[0.3em] uppercase flex items-center gap-3">
                <BarChart3 size={14} className="text-cyan-400" /> Execution Stream
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-slate-600 text-[9px] font-black uppercase tracking-[0.2em] bg-slate-950/40">
                  <tr><th className="px-10 py-6">Event Horizon</th><th className="px-10 py-6">Asset Vector</th><th className="px-10 py-6">Side</th><th className="px-10 py-6 text-right">PnL Result</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40 font-mono text-xs text-slate-400">
                  {tradeLogs.length > 0 ? tradeLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-10 py-6 text-slate-500 flex items-center gap-3"><Clock size={14} className="opacity-30" /> {log.exit_time ? new Date(log.exit_time).toLocaleTimeString() : 'In Flight...'}</td>
                      <td className="px-10 py-6 font-black text-slate-300 uppercase">{log.symbol}</td>
                      <td className="px-10 py-6"><span className={`text-[9px] font-black px-3 py-1 rounded-lg border uppercase ${log.side === 'LONG' || log.side === 'Buy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>{log.side}</span></td>
                      <td className={`px-10 py-6 text-right font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{log.pnl != null ? log.pnl.toFixed(4) : '--'}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan="4" className="py-40 text-center opacity-10 font-black uppercase text-[11px] tracking-[1em] italic">Scanning consciousness...</td></tr>
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