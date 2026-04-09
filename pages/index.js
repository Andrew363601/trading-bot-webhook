import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Shield 
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Fallback assets if the database is empty
const ASSETS = ['DOGE-USDT', 'SOL-USDT', 'BTC-USDT', 'ETH-USDT', 'AVAX-USDT'];

const STRATEGY_DETAILS = {
  "LTC_4x4_STF": {
    name: "Consciousness Coherence v3.1",
    description: "A high-precision resonance engine. It calculates the Market Coherence Index (MCI) by synchronizing ADX trend power, Efficiency Ratios, and SMA alignment.",
    logic: "MCI > 0.7 + DMI Cross"
  },
  "MOMENTUM_SCALPER": {
    name: "Neural Velocity Scalper",
    description: "Built for high-volatility environments. This logic exploits micro-trend breakouts by monitoring volume spikes and RSI divergence.",
    logic: "Vol Spike > 2.0x + RSI Divergence"
  }
};

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('DOGE-USDT');
  const [dynamicAssets, setDynamicAssets] = useState(ASSETS);
  const [selectedStrat, setSelectedStrat] = useState('LTC_4x4_STF');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Vercel AI SDK Chat
  const { messages, input, handleInputChange, handleSubmit, append } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      // 1. Fetch Execution Logs for the center table
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', ''))
        .order('id', { ascending: false });
      
      setTradeLogs(logs || []);

      // 2. Fetch Active Strategies to dynamically build the sidebar menu
      const { data: configs } = await supabase
        .from('strategy_config')
        .select('asset')
        .eq('is_active', true);

      if (configs && configs.length > 0) {
        // Extract unique asset names
        const uniqueAssets = [...new Set(configs.map(c => c.asset))];
        setDynamicAssets(uniqueAssets);
      }
    } catch (e) { 
      console.error(e); 
    } finally { 
      setLoading(false); 
    }
  }, [activeAsset]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => { 
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); 
  }, [messages]);

  // Function to handle strategy click and "Bot Briefing"
  const handleStrategySelect = (id) => {
    setSelectedStrat(id);
    const strat = STRATEGY_DETAILS[id];
    
    // Programmatically tell the bot to explain this strategy
    append({
      role: 'user',
      content: `Brief me on the ${strat.name} strategy for ${activeAsset}. What is its current logic?`
    });
  };

  // Inject Dynamic TradingView Chart
  useEffect(() => {
    const container = document.getElementById('tv_chart_container');
    if (!container) return;
    container.innerHTML = '';
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
          "container_id": "tv_chart_container",
          "backgroundColor": "#020617",
          "hide_top_toolbar": true,
          "hide_legend": true,
          "save_image": false,
        });
      }
    };
    container.appendChild(script);
  }, [activeAsset]);

  if (loading) return <div className="min-h-screen bg-[#020617] flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">Establishing Nexus...</div>;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 font-sans flex flex-col gap-4">
      <header className="max-w-[1800px] w-full mx-auto flex justify-between items-center border-b border-white/5 pb-4">
        <h1 className="text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
            <Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn
        </div>
      </header>

      <main className="max-w-[1800px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 grow overflow-hidden">
        
        {/* LEFT: Asset Watchlist & Capital (Sidebar) */}
        <div className="lg:col-span-2 flex flex-col h-full min-h-0">
          <div className="text-[10px] font-black uppercase text-slate-500 mb-2 px-2 tracking-widest flex-shrink-0">Market Scanners</div>
          
          <div className="space-y-1 overflow-y-auto pr-2 flex-grow">
            {/* Map over the constant ASSETS array instead of dynamicAssets */}
            {ASSETS.map(asset => (
                <button
                key={asset}
                onClick={() => setActiveAsset(asset)}
                className={`w-full text-left px-4 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all border ${
                    activeAsset === asset 
                    ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.1)]' 
                    : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'
                }`}
                >
                <div className="flex justify-between items-center">
                    {asset}
                    {activeAsset === asset && <Activity size={12} className="text-cyan-400 animate-pulse" />}
                </div>
                </button>
            ))}
          </div>

          {/* Capital Allocation Card (Pushed to bottom) */}
          <div className="mt-auto pt-6 space-y-4 border-t border-white/5 bg-black/20 p-4 rounded-[2rem] flex-shrink-0">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex justify-between">
              Capital Allocation 
              <span className="text-cyan-400">● LIVE</span>
            </div>
            
            <div className="space-y-3">
              {/* Live Portfolio */}
              <div className="flex justify-between items-end border-b border-white/5 pb-2">
                <div>
                  <div className="text-[8px] text-slate-500 uppercase font-bold">Total Equity</div>
                  <div className="text-lg font-black font-mono text-white">$1,240.52</div>
                </div>
                <div className="text-right">
                  <div className="text-[8px] text-emerald-400 font-black uppercase">ROI</div>
                  <div className="text-xs font-black text-emerald-400 font-mono">+4.2%</div>
                </div>
              </div>

              {/* Paper Portfolio */}
              <div className="flex justify-between items-end opacity-60">
                <div>
                  <div className="text-[8px] text-slate-500 uppercase font-bold">Paper Funds</div>
                  <div className="text-md font-black font-mono text-slate-300">$5,000.00</div>
                </div>
                <div className="text-right text-[10px] text-slate-500 font-mono italic">Demo Only</div>
              </div>
            </div>
          </div>
        </div>

        {/* CENTER: Chart & Trades (Main View) */}
        <div className="lg:col-span-7 flex flex-col gap-6 overflow-hidden">
          {/* Chart Container */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden min-h-[450px] relative shadow-2xl flex-shrink-0">
            <div id="tv_chart_container" className="absolute inset-0" />
            
            {/* Live Plot Overlay (Floating) */}
            <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 max-w-[220px]">
               {tradeLogs.slice(0, 3).map((log, i) => (
                 <div key={i} className="bg-black/70 backdrop-blur-md border border-white/10 p-2 px-3 rounded-xl text-[9px] font-mono flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={log.side === 'BUY' || log.side === 'LONG' ? 'text-emerald-400' : 'text-amber-400'}>●</span>
                      <span className="text-slate-300 uppercase truncate">{log.side} @ {log.entry_price}</span>
                    </div>
                    <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400 font-bold'}>
                        {log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(2)}
                    </span>
                 </div>
               ))}
            </div>
          </div>

          {/* Execution History Table */}
          <div className="bg-slate-900/40 border border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col grow shadow-xl">
             <div className="px-6 py-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2">
                <Target size={14} className="text-cyan-400" /> Execution Stream: {activeAsset}
             </div>
             <div className="overflow-y-auto max-h-[300px]">
                <table className="w-full text-left table-fixed">
                  <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] sticky top-0 backdrop-blur-md z-10">
                    <tr>
                      <th className="w-1/4 px-6 py-3">Time</th>
                      <th className="w-1/4 px-6 py-3 text-center">Vector</th>
                      <th className="w-1/4 px-6 py-3">Entry</th>
                      <th className="w-1/4 px-6 py-3 text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                    {tradeLogs.map((log, i) => (
                      <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4 text-[10px] text-slate-500 truncate">{new Date(log.exit_time).toLocaleTimeString()}</td>
                        <td className="px-6 py-4 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${log.side === 'LONG' || log.side === 'BUY' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                                {log.side}
                            </span>
                        </td>
                        <td className="px-6 py-4 text-slate-300 truncate">{log.entry_price}</td>
                        <td className={`px-6 py-4 text-right font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                    {tradeLogs.length === 0 && (
                        <tr><td colSpan="4" className="py-20 text-center text-slate-600 italic uppercase text-[10px] tracking-widest">No market activity recorded</td></tr>
                    )}
                  </tbody>
                </table>
             </div>
          </div>
        </div>

        {/* RIGHT: Strategy Matrix & Agent (Sidebar) */}
        <div className="lg:col-span-3 flex flex-col gap-6 overflow-hidden h-full min-h-0">
          
          {/* Strategy Matrix (On Top of Terminal) */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center gap-2"><Layers size={14} className="text-cyan-400" /> Active Matrix</h3>
            <div className="flex flex-col gap-3">
              {Object.keys(STRATEGY_DETAILS).map(id => (
                <button 
                  key={id} 
                  onClick={() => handleStrategySelect(id)}
                  className={`p-4 rounded-2xl border text-left transition-all ${
                    selectedStrat === id ? 'bg-indigo-500/10 border-indigo-500/30 ring-1 ring-indigo-500/20' : 'bg-black/20 border-white/5 opacity-60 hover:opacity-100'
                  }`}
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-black text-white uppercase tracking-tighter">{id}</span>
                    <TrendingUp size={12} className={selectedStrat === id ? 'text-emerald-400' : 'text-slate-600'} />
                  </div>
                  <div className="text-[9px] text-slate-500 uppercase font-mono italic">Initiate Briefing</div>
                </button>
              ))}
            </div>
          </div>

          {/* Agent Terminal (Bottom Right) */}
          <div className="bg-slate-950 border border-white/10 rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden flex-grow min-h-0">
            <div className="px-6 py-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500/40" />
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40" />
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
              </div>
            </div>
            
            <div className="p-4 overflow-y-auto font-mono text-xs space-y-4 flex-grow">
              {messages.length === 0 && (
                <div className="text-slate-600 italic leading-relaxed uppercase text-[10px]">
                  Telemetric link established. Select a strategy matrix or query system vectors...
                </div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] rounded-2xl px-4 py-3 leading-relaxed ${
                    m.role === 'user' 
                    ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-[10px]' 
                    : 'bg-slate-900/80 text-cyan-400 border border-white/5'
                  }`}>
                    {m.content}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-3 flex-shrink-0">
              <input
                className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500/50 transition-all"
                value={input} 
                onChange={handleInputChange} 
                placeholder="Query parameters..."
              />
              <button type="submit" className="bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-xl px-4 py-3 hover:bg-indigo-500/30 transition-all flex-shrink-0">
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}