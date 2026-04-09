// pages/index.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, Send } from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function Dashboard() {
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);

  // Vercel AI SDK Chat Hook
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    if (isToggling) return;
    try {
      const { data: strat } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
      setActiveStrategy(strat);
      const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(6);
      setTradeLogs(logs || []);
    } catch (e) { 
      console.error("Fetch Error:", e); 
    } finally { 
      setLoading(false); 
    }
  }, [isToggling]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleMode = async () => {
    if (!activeStrategy || isToggling) return;
    setIsToggling(true);
    const newMode = activeStrategy.execution_mode === 'LIVE' ? 'PAPER' : 'LIVE';
    setActiveStrategy(prev => ({ ...prev, execution_mode: newMode }));
    await supabase.from('strategy_config').update({ execution_mode: newMode }).eq('id', activeStrategy.id);
    setTimeout(() => setIsToggling(false), 2000);
  };

  if (loading) return <div className="min-h-screen bg-[#020617] flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">Establishing Nexus...</div>;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-6 font-sans flex flex-col">
      <header className="max-w-7xl w-full mx-auto flex justify-between items-center mb-8 border-b border-white/5 pb-6">
        <h1 className="text-3xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Engine</h1>
        <div className="flex items-center gap-4">
           <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
           <button 
             onClick={toggleMode}
             className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all ${
               activeStrategy?.execution_mode === 'LIVE' 
               ? 'bg-red-500/10 text-red-400 border-red-500/30' 
               : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
             }`}
           >
             {activeStrategy?.execution_mode || 'PAPER'}
           </button>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6 grow">
        {/* Left Column: Vector State */}
        <div className="lg:col-span-1 space-y-6 flex flex-col">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2rem] p-6 shadow-2xl backdrop-blur-xl">
            <h3 className="text-slate-500 text-[10px] font-black uppercase mb-4 flex items-center gap-2"><Cpu size={14} className="text-indigo-400" /> Vector State</h3>
            <div className="text-xl font-black text-white italic tracking-tighter uppercase leading-tight">{activeStrategy?.strategy}</div>
            <div className="text-indigo-400 font-mono text-[10px] uppercase font-bold tracking-widest italic mb-4">v{activeStrategy?.version}</div>
            <div className="bg-black/60 border border-white/5 rounded-xl p-4">
              <pre className="text-[10px] font-mono text-cyan-400/90 leading-relaxed overflow-x-auto">
                {activeStrategy ? JSON.stringify(activeStrategy.parameters, null, 2) : 'No data'}
              </pre>
            </div>
          </div>
        </div>

        {/* Center/Right Column: Execution Stream & Agent Terminal */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          {/* Top: Execution Stream */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2rem] shadow-2xl overflow-hidden backdrop-blur-xl h-64 flex flex-col">
            <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2 bg-slate-900/40">
              <BarChart3 size={14} className="text-cyan-400" /> Execution Stream
            </div>
            <div className="overflow-y-auto grow">
              <table className="w-full text-left">
                <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] sticky top-0 backdrop-blur-md">
                  <tr><th className="px-6 py-3">Time</th><th className="px-6 py-3">Asset</th><th className="px-6 py-3">Mode</th><th className="px-6 py-3 text-right">PnL</th></tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                  {tradeLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-white/[0.02]">
                      <td className="px-6 py-3 flex items-center gap-2 text-slate-500"><Clock size={12} /> {new Date(log.exit_time).toLocaleTimeString()}</td>
                      <td className="px-6 py-3 font-black text-slate-200">{log.symbol}</td>
                      <td className="px-6 py-3">
                        <span className={`text-[8px] font-black px-2 py-0.5 rounded border ${log.execution_mode === 'LIVE' ? 'text-red-400 border-red-500/30' : 'text-slate-500 border-white/10'}`}>
                          {log.execution_mode}
                        </span>
                      </td>
                      <td className={`px-6 py-3 text-right font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{log.pnl >= 0 ? '+' : ''}{log.pnl.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom: AI Agent Terminal */}
          <div className="bg-slate-950 border border-white/10 rounded-[2rem] shadow-2xl flex flex-col overflow-hidden h-72">
            <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2 bg-slate-900/40">
              <TerminalIcon size={14} className="text-indigo-400" /> Agent Console
            </div>
            
            {/* Chat History */}
            <div className="p-6 grow overflow-y-auto font-mono text-xs space-y-4">
              {messages.length === 0 && (
                <div className="text-slate-600 italic">Nexus Agent initialized. Awaiting input...</div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-4 py-3 ${m.role === 'user' ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30' : 'bg-slate-800/50 text-cyan-300 border border-white/5'}`}>
                    {m.content}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-4">
              <input
                className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
                value={input}
                onChange={handleInputChange}
                placeholder="Query strategy reasoning..."
              />
              <button type="submit" className="bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-400 border border-indigo-500/30 rounded-xl px-4 py-3 transition-all flex items-center justify-center">
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}