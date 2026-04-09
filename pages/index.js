// pages/index.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, Send, Activity, Layers } from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['DOGE-USDT', 'SOL-USDT', 'BTC-USDT', 'AVAX-USDT'];

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('DOGE-USDT');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Vercel AI SDK Chat
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  const chatEndRef = useRef(null);

  // 1. Fetch Logs specific to the selected asset
  const fetchData = useCallback(async () => {
    try {
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', '')) // Matches DOGEUSDT
        .order('id', { ascending: false })
        .limit(10);
      setTradeLogs(logs || []);
    } catch (e) { 
      console.error("Fetch Error:", e); 
    } finally { 
      setLoading(false); 
    }
  }, [activeAsset]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // 2. Inject Dynamic TradingView Chart
  useEffect(() => {
    const container = document.getElementById('tv_chart_container');
    if (!container) return;
    container.innerHTML = ''; // Clear old chart on asset change
    
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
      if (window.TradingView) {
        new window.TradingView.widget({
          "autosize": true,
          "symbol": `COINBASE:${activeAsset.replace('-', '')}`,
          "interval": "60",
          "theme": "dark",
          "style": "1",
          "locale": "en",
          "enable_publishing": false,
          "backgroundColor": "rgba(2, 6, 23, 1)",
          "gridColor": "rgba(255, 255, 255, 0.05)",
          "hide_top_toolbar": true,
          "hide_legend": true,
          "container_id": "tv_chart_container"
        });
      }
    };
    container.appendChild(script);
  }, [activeAsset]);

  if (loading) return <div className="min-h-screen bg-[#020617] flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">Establishing Nexus...</div>;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 font-sans flex flex-col">
      <header className="max-w-[1600px] w-full mx-auto flex justify-between items-center mb-6 border-b border-white/5 pb-4">
        <h1 className="text-2xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
      </header>

      <main className="max-w-[1600px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 grow h-full">
        
        {/* Left Sidebar: Asset Watchlist */}
        <div className="lg:col-span-2 space-y-2">
          <div className="text-[10px] font-black uppercase text-slate-500 mb-4 tracking-widest px-2">Active Scanners</div>
          {ASSETS.map(asset => (
            <button
              key={asset}
              onClick={() => setActiveAsset(asset)}
              className={`w-full text-left px-4 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all border ${
                activeAsset === asset 
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.2)]' 
                : 'bg-slate-900/40 text-slate-500 border-transparent hover:bg-slate-800'
              }`}
            >
              <div className="flex justify-between items-center">
                {asset}
                {activeAsset === asset && <Activity size={12} className="text-cyan-400 animate-pulse" />}
              </div>
            </button>
          ))}
        </div>

        {/* Center/Right Column */}
        <div className="lg:col-span-10 flex flex-col gap-6">
          
          {/* Top Row: Chart & Strategy Matrix */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[400px]">
            {/* Live Chart Widget */}
            <div className="lg:col-span-2 bg-slate-900/50 border border-white/10 rounded-[2rem] shadow-2xl overflow-hidden backdrop-blur-xl relative">
               <div id="tv_chart_container" className="absolute inset-0" />
            </div>

            {/* Strategy Matrix (Placeholder for Scanner Data) */}
            <div className="lg:col-span-1 bg-slate-900/50 border border-white/10 rounded-[2rem] shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col">
              <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2 bg-slate-900/40">
                <Layers size={14} className="text-cyan-400" /> Deployed Strategies ({activeAsset})
              </div>
              <div className="p-4 space-y-3 overflow-y-auto">
                {/* Mockup blocks - These will map to real DB stats later */}
                <div className="bg-black/40 border border-white/5 rounded-xl p-4 flex justify-between items-center">
                   <div>
                     <div className="text-xs font-black text-white uppercase tracking-wider">LTC_4x4_STF</div>
                     <div className="text-[10px] text-slate-500 font-mono mt-1">Coherence: 0.70 | LB: 14</div>
                   </div>
                   <div className="text-right">
                     <span className="text-[9px] font-black px-2 py-0.5 rounded border text-slate-500 border-white/10 uppercase bg-slate-800">PAPER</span>
                     <div className="text-emerald-400 text-xs font-black mt-1">+1.24%</div>
                   </div>
                </div>
                <div className="bg-black/40 border border-white/5 rounded-xl p-4 flex justify-between items-center">
                   <div>
                     <div className="text-xs font-black text-white uppercase tracking-wider">MOMENTUM_SCALPER</div>
                     <div className="text-[10px] text-slate-500 font-mono mt-1">RSI_Length: 10</div>
                   </div>
                   <div className="text-right">
                     <span className="text-[9px] font-black px-2 py-0.5 rounded border text-red-400 border-red-500/30 uppercase bg-red-500/10">LIVE</span>
                     <div className="text-emerald-400 text-xs font-black mt-1">+0.81%</div>
                   </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Row: Logs & Chat */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 grow min-h-[300px]">
             {/* Execution Stream */}
            <div className="lg:col-span-2 bg-slate-900/50 border border-white/10 rounded-[2rem] shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col">
              <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2 bg-slate-900/40">
                <BarChart3 size={14} className="text-cyan-400" /> Execution Stream
              </div>
              <div className="overflow-y-auto grow">
                <table className="w-full text-left">
                  <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] sticky top-0 backdrop-blur-md">
                    <tr><th className="px-6 py-3">Time</th><th className="px-6 py-3">Asset</th><th className="px-6 py-3">Strategy</th><th className="px-6 py-3 text-right">PnL</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                    {tradeLogs.map((log, i) => (
                      <tr key={i} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-3 flex items-center gap-2 text-slate-500"><Clock size={12} /> {new Date(log.exit_time).toLocaleTimeString()}</td>
                        <td className="px-6 py-3 font-black text-slate-200">{log.symbol}</td>
                        <td className="px-6 py-3 text-indigo-300">{log.strategy_id || 'DEFAULT'}</td>
                        <td className={`px-6 py-3 text-right font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(4) || '0.0000'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* AI Agent Terminal */}
            <div className="lg:col-span-1 bg-slate-950 border border-white/10 rounded-[2rem] shadow-2xl flex flex-col overflow-hidden">
              <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2 bg-slate-900/40">
                <TerminalIcon size={14} className="text-indigo-400" /> Agent Console
              </div>
              <div className="p-4 grow overflow-y-auto font-mono text-xs space-y-4">
                {messages.length === 0 && <div className="text-slate-600 italic">Nexus Agent initialized. Awaiting input...</div>}
                {messages.map(m => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-xl px-4 py-3 ${m.role === 'user' ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30' : 'bg-slate-800/50 text-cyan-300 border border-white/5'}`}>
                      {m.content}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-4">
                <input
                  className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50"
                  value={input} onChange={handleInputChange} placeholder="Query agent..."
                />
                <button type="submit" className="bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-400 border border-indigo-500/30 rounded-xl px-4 py-3"><Send size={16} /></button>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}