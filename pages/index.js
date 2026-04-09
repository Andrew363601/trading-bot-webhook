// pages/index.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, Info, TrendingUp, Target 
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['DOGE-USDT', 'SOL-USDT', 'BTC-USDT'];

// Strategy Meta Information
const STRATEGY_META = {
  'LTC_4x4_STF': {
    name: 'Consciousness Coherence v3.1',
    desc: 'Uses the Market Coherence Index (MCI) to identify "Resonance" between ADX trend strength, Efficiency Ratios, and SMA alignment. It only fires when the market structure is in absolute synchronization.',
    params: 'Threshold: 0.70 | ER Lookback: 10'
  },
  'MOMENTUM_SCALPER': {
    name: 'Neural Velocity Scalper',
    desc: 'High-frequency momentum engine that exploits micro-trends using RSI divergence and volume clusters. Built for rapid entries/exits during high volatility.',
    params: 'RSI: 10 | Vol Spike: 2.0x'
  }
};

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('DOGE-USDT');
  const [selectedStrategy, setSelectedStrategy] = useState('LTC_4x4_STF');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', ''))
        .order('id', { ascending: false });
      
      // Filter logs by the selected strategy if one is active
      const filtered = selectedStrategy 
        ? logs.filter(l => l.strategy_id === selectedStrategy || (!l.strategy_id && selectedStrategy === 'LTC_4x4_STF'))
        : logs;

      setTradeLogs(filtered || []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  }, [activeAsset, selectedStrategy]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => {
    const container = document.getElementById('tv_chart_container');
    if (!container || !window.TradingView) return;
    new window.TradingView.widget({
      "autosize": true,
      "symbol": `COINBASE:${activeAsset.replace('-', '')}`,
      "interval": "60",
      "theme": "dark",
      "container_id": "tv_chart_container",
      "hide_top_toolbar": true,
      "backgroundColor": "#020617"
    });
  }, [activeAsset]);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 font-sans flex flex-col gap-4">
      {/* Top Header */}
      <header className="flex justify-between items-center border-b border-white/5 pb-4">
        <h1 className="text-xl font-black italic tracking-tighter text-indigo-400 uppercase">Nexus Command</h1>
        <div className="flex gap-4 items-center">
            {ASSETS.map(a => (
                <button key={a} onClick={() => setActiveAsset(a)} className={`px-3 py-1 rounded-full text-[10px] font-black border transition-all ${activeAsset === a ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300' : 'border-transparent text-slate-500'}`}>{a}</button>
            ))}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 grow">
        
        {/* Left Column: Visuals */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          <div className="h-[450px] bg-slate-900/50 border border-white/10 rounded-[2rem] overflow-hidden relative">
             <div id="tv_chart_container" className="absolute inset-0" />
          </div>

          {/* Strategy Details (Appears when Strategy is clicked) */}
          <div className="bg-slate-900/80 border border-white/10 rounded-[2.5rem] p-8 backdrop-blur-xl relative overflow-hidden">
             <div className="absolute top-0 right-0 p-8 opacity-5"><TrendingUp size={120} /></div>
             <div className="flex justify-between items-start mb-6">
                <div>
                    <h2 className="text-2xl font-black text-white italic uppercase tracking-tighter">{STRATEGY_META[selectedStrategy]?.name}</h2>
                    <p className="text-indigo-400 font-mono text-[10px] mt-1 uppercase tracking-widest">{STRATEGY_META[selectedStrategy]?.params}</p>
                </div>
                <div className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full text-[10px] font-black uppercase">Active</div>
             </div>
             <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">{STRATEGY_META[selectedStrategy]?.desc}</p>
          </div>
        </div>

        {/* Right Column: Intelligence */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          
          {/* Strategy Matrix */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2rem] p-6">
            <h3 className="text-[10px] font-black text-slate-500 uppercase mb-4 flex items-center gap-2"><Layers size={14} /> System Matrix</h3>
            <div className="space-y-3">
              {Object.keys(STRATEGY_META).map(id => (
                <div 
                  key={id} 
                  onClick={() => setSelectedStrategy(id)}
                  className={`p-4 rounded-2xl border cursor-pointer transition-all ${selectedStrategy === id ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-black/20 border-white/5 opacity-50 hover:opacity-100'}`}
                >
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-white uppercase">{id}</span>
                    <span className="text-emerald-400 text-[10px] font-black">+2.4%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Trade Execution Stream */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2rem] overflow-hidden flex flex-col grow min-h-[400px]">
             <div className="p-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2">
                <Target size={14} className="text-cyan-400" /> Execution History
             </div>
             <div className="overflow-y-auto p-4 space-y-3">
                {tradeLogs.map((log, i) => (
                    <div key={i} className="bg-black/40 border border-white/5 rounded-xl p-4 flex justify-between items-center group hover:border-indigo-500/30 transition-all">
                        <div>
                            <div className="text-[10px] font-black text-slate-200 uppercase">{log.side} @ {log.entry_price}</div>
                            <div className="text-[8px] font-mono text-slate-500 mt-1 uppercase">{new Date(log.exit_time).toLocaleString()}</div>
                        </div>
                        <div className={`text-xs font-black ${log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(4)}
                        </div>
                    </div>
                ))}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}