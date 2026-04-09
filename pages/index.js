import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Shield 
} from 'lucide-react';

const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['DOGE-USDT', 'SOL-USDT', 'BTC-USDT', 'ETH-USDT', 'PEPE-USDT'];

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
  const [selectedStrat, setSelectedStrat] = useState('LTC_4x4_STF');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Vercel AI SDK Chat
  const { messages, input, handleInputChange, handleSubmit, append, setMessages } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', ''))
        .order('id', { ascending: false });
      
      setTradeLogs(logs || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [activeAsset]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

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
      <header className="max-w-[1600px] w-full mx-auto flex justify-between items-center border-b border-white/5 pb-4">
        <h1 className="text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
      </header>

      <main className="max-w-[1600px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 grow">
        
        {/* Left Sidebar: Asset Watchlist */}
        <div className="lg:col-span-2 space-y-2 flex flex-col">
          <div className="text-[10px] font-black uppercase text-slate-500 mb-2 px-2 tracking-widest">Market Scanners</div>
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

        {/* Center: Chart Area */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden h-[500px] relative shadow-2xl">
            <div id="tv_chart_container" className="absolute inset-0" />
            
            {/* Trade Plot Overlay */}
            <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
               {tradeLogs.slice(0, 4).map((log, i) => (
                 <div key={i} className="bg-black/70 backdrop-blur-md border border-white/10 p-2 px-3 rounded-xl text-[9px] font-mono flex items-center justify-between gap-4 min-w-[180px]">
                    <div className="flex items-center gap-2">
                      <span className={log.side === 'BUY' || log.side === 'LONG' ? 'text-emerald-400' : 'text-amber-400'}>●</span>
                      <span className="text-slate-300 uppercase">{log.side} @ {log.entry_price}</span>
                    </div>
                    <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400 font-bold'}>{log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(2)}</span>
                 </div>
               ))}
               {tradeLogs.length === 0 && <div className="bg-black/40 p-2 rounded text-[9px] text-slate-500 italic uppercase">No trades on current horizon</div>}
            </div>
          </div>

          {/* System Matrix: Strategy Selector */}
          <div className="bg-slate-900/40 border border-white/10 rounded-[2rem] p-6 shadow-xl">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center gap-2"><Layers size={14} className="text-cyan-400" /> Active System Matrix</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  <div className="text-[9px] text-slate-500 uppercase font-mono italic">Click to brief agent</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Agent Terminal */}
        <div className="lg:col-span-3 flex flex-col overflow-hidden bg-slate-950 border border-white/10 rounded-[2.5rem] shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center justify-between">
            <div className="flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500/40" />
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40" />
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
            </div>
          </div>
          
          <div className="p-4 grow overflow-y-auto font-mono text-xs space-y-4">
            {messages.length === 0 && (
              <div className="text-slate-600 italic leading-relaxed uppercase text-[10px]">
                Nexus system ready. Asset: {activeAsset}. Select a strategy to initiate telemetry briefing...
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

          <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-3">
            <input
              className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500/50 transition-all"
              value={input} 
              onChange={handleInputChange} 
              placeholder="Query parameters or logic..."
            />
            <button type="submit" className="bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-xl px-4 py-3 hover:bg-indigo-500/30 transition-all">
              <Send size={16} />
            </button>
          </form>
        </div>

      </main>
    </div>
  );
}