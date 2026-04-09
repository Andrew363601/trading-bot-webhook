import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Info, Shield 
} from 'lucide-react';

const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['DOGE-USDT', 'SOL-USDT', 'BTC-USDT', 'ETH-USDT', 'PEPE-USDT'];

const STRATEGY_DETAILS = {
  "LTC_4x4_STF": {
    name: "Consciousness Coherence v3.1",
    description: "A high-precision resonance engine. It calculates the Market Coherence Index (MCI) by synchronizing ADX trend power, Efficiency Ratios (price density), and SMA alignment. It only fires when the field is perfectly coherent.",
    logic: "MCI > 0.7 + DMI Cross",
    author: "Nexus Alpha"
  },
  "MOMENTUM_SCALPER": {
    name: "Neural Velocity Scalper",
    description: "Built for high-volatility environments. This logic exploits micro-trend breakouts by monitoring volume spikes and RSI divergence. It is designed for rapid 'in-and-out' liquidity captures.",
    logic: "Vol Spike > 2.0x + RSI Divergence",
    author: "Nexus Beta"
  }
};

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('DOGE-USDT');
  const [selectedStrat, setSelectedStrat] = useState('LTC_4x4_STF');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [activeConfig, setActiveConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const { messages, input, handleInputChange, handleSubmit } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      // Fetch Logs for specific asset
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', ''))
        .order('id', { ascending: false });
      
      setTradeLogs(logs || []);

      // Fetch Config for selected strategy
      const { data: config } = await supabase
        .from('strategy_config')
        .select('*')
        .eq('strategy', selectedStrat)
        .eq('is_active', true)
        .single();
      
      setActiveConfig(config);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [activeAsset, selectedStrat]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

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
      <header className="flex justify-between items-center border-b border-white/5 pb-4">
        <h1 className="text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
        <div className="flex gap-4 items-center">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 grow">
        
        {/* Left Sidebar: Asset Selection */}
        <div className="lg:col-span-2 space-y-2 flex flex-col">
          <div className="text-[10px] font-black uppercase text-slate-500 mb-2 px-2">Market Scanners</div>
          {ASSETS.map(asset => (
            <button
              key={asset}
              onClick={() => setActiveAsset(asset)}
              className={`w-full text-left px-4 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all border ${
                activeAsset === asset 
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' 
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

        {/* Center: Chart & Strategy Info */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden h-[450px] relative shadow-2xl">
            <div id="tv_chart_container" className="absolute inset-0" />
            
            {/* Trade Plot Summary Overlay */}
            <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
               {tradeLogs.slice(0, 3).map((log, i) => (
                 <div key={i} className="bg-black/60 backdrop-blur-md border border-white/10 p-2 rounded-lg text-[9px] font-mono flex items-center gap-2">
                    <span className={log.side === 'BUY' || log.side === 'LONG' ? 'text-emerald-400' : 'text-amber-400'}>●</span>
                    <span className="text-slate-300">{log.side} @ {log.entry_price}</span>
                    <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(2)}</span>
                 </div>
               ))}
            </div>
          </div>

          <div className="bg-slate-900 border border-white/10 rounded-[2.5rem] p-8 backdrop-blur-xl relative overflow-hidden group">
             <div className="absolute -right-4 -top-4 opacity-[0.03] group-hover:opacity-[0.05] transition-opacity">
                <Target size={180} />
             </div>
             <div className="flex justify-between items-start mb-4">
                <div>
                   <h2 className="text-2xl font-black italic uppercase tracking-tighter text-white">{STRATEGY_DETAILS[selectedStrat].name}</h2>
                   <div className="text-indigo-400 font-mono text-[10px] uppercase tracking-widest mt-1">v{activeConfig?.version || '1.0'} | {STRATEGY_DETAILS[selectedStrat].logic}</div>
                </div>
                <div className="flex gap-2">
                   <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full text-[10px] font-black uppercase">Active</div>
                   <div className="px-3 py-1 bg-white/5 border border-white/10 text-slate-500 rounded-full text-[10px] font-black uppercase">{activeConfig?.execution_mode || 'PAPER'}</div>
                </div>
             </div>
             <p className="text-slate-400 text-sm leading-relaxed max-w-3xl">{STRATEGY_DETAILS[selectedStrat].description}</p>
          </div>
        </div>

        {/* Right: Strategy Selection & Chat */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center gap-2"><Layers size={14} className="text-cyan-400" /> System Matrix</h3>
            <div className="space-y-3">
              {Object.keys(STRATEGY_DETAILS).map(id => (
                <button 
                  key={id} 
                  onClick={() => setSelectedStrat(id)}
                  className={`w-full p-4 rounded-2xl border text-left transition-all ${
                    selectedStrat === id ? 'bg-indigo-500/10 border-indigo-500/30 ring-1 ring-indigo-500/20' : 'bg-black/20 border-white/5 opacity-60 hover:opacity-100'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-white uppercase">{id}</span>
                    <TrendingUp size={12} className={selectedStrat === id ? 'text-emerald-400' : 'text-slate-600'} />
                  </div>
                  <div className="text-[9px] text-slate-500 mt-1 uppercase font-mono italic">Efficiency: High</div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-slate-950 border border-white/10 rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden grow min-h-[350px]">
             <div className="px-6 py-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2">
                <TerminalIcon size={14} className="text-indigo-400" /> Agent Terminal
             </div>
             <div className="p-4 grow overflow-y-auto font-mono text-xs space-y-4">
                {messages.length === 0 && <div className="text-slate-600 italic">Nexus initialized. Awaiting market vector query...</div>}
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
                  className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono text-white focus:outline-none focus:border-indigo-500/50"
                  value={input} onChange={handleInputChange} placeholder="Query intelligence..."
                />
                <button type="submit" className="bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-xl px-4 py-3"><Send size={16} /></button>
             </form>
          </div>
        </div>
      </div>
    </div>
  );
}