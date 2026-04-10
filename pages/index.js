import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from 'ai/react';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Shield, Wallet 
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'AVAX-USDT'];

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('DOGE-USDT');
  const [tradeLogs, setTradeLogs] = useState([]);
  const [activeStrategies, setActiveStrategies] = useState([]);
  const [scanStream, setScanStream] = useState([]); // NEW: Scan telemetry state
  const [portfolio, setPortfolio] = useState({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 } });
  const [selectedStrat, setSelectedStrat] = useState(null);
  const [loading, setLoading] = useState(true);

  const { messages, input, handleInputChange, handleSubmit, append } = useChat();
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      // 1. Fetch Real Portfolio Data
      const portResp = await fetch('/api/portfolio');
      if (portResp.ok) {
        const portData = await portResp.json();
        setPortfolio(portData);
      }

      // 2. Fetch Execution Logs
      const { data: logs } = await supabase
        .from('trade_logs')
        .select('*')
        .eq('symbol', activeAsset.replace('-', ''))
        .order('id', { ascending: false });
      setTradeLogs(logs || []);

      // 3. Fetch Active Strategies (Dynamic Matrix)
      const { data: configs } = await supabase
        .from('strategy_config')
        .select('*')
        .eq('is_active', true);
      setActiveStrategies(configs || []);

      // 4. Fetch Live Scan Telemetry
      const { data: scans } = await supabase
        .from('scan_results')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(15);
      if (scans) setScanStream(scans);
      
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

  // FIX: Auto-scroll chat to bottom
  useEffect(() => { 
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); 
  }, [messages]);

  const handleStrategySelect = (stratId) => {
    setSelectedStrat(stratId);
    append({
      role: 'user',
      content: `Brief me on the ${stratId} strategy currently running on ${activeAsset}. What parameters are dictating its logic?`
    });
  };

  const currentAssetStrategies = activeStrategies.filter(s => s.asset === activeAsset);

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
        
        {/* LEFT: Capital & Watchlist (Sidebar) */}
        <div className="lg:col-span-2 flex flex-col h-[calc(100vh-100px)] min-h-0 gap-6">
          
          <div className="bg-slate-900/50 p-5 rounded-[2rem] border border-white/10 flex-shrink-0 shadow-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex justify-between mb-4">
              Capital Allocation <span className="text-cyan-400 animate-pulse">● LIVE</span>
            </div>
            <div className="space-y-4">
              <div className="border-b border-white/5 pb-3">
                <div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Shield size={10} className="text-emerald-400"/> Live Equity (Coinbase)</div>
                <div className="text-xl font-black font-mono text-white">${portfolio.live?.balance?.toFixed(2) || '0.00'}</div>
              </div>
              <div>
                <div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Cpu size={10} className="text-indigo-400"/> Nexus Paper Funds</div>
                <div className="flex justify-between items-end">
                  <div className="text-lg font-black font-mono text-slate-300">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</div>
                  <div className={`text-[10px] font-mono font-black ${portfolio.paper?.balance >= portfolio.paper?.initial ? 'text-emerald-400' : 'text-red-400'}`}>
                    {portfolio.paper?.balance >= portfolio.paper?.initial ? '+' : ''}
                    {(((portfolio.paper?.balance - portfolio.paper?.initial) / portfolio.paper?.initial) * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Asset Watchlist */}
          <div className="flex flex-col flex-shrink-0">
            <div className="text-[10px] font-black uppercase text-slate-500 mb-3 px-2 tracking-widest flex items-center gap-2"><Target size={12}/> Market Scanners</div>
            <div className="space-y-1">
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
          </div>

          {/* LIVE SCAN TELEMETRY */}
          <div className="mt-2 pt-4 border-t border-white/5 flex flex-col min-h-0 flex-grow">
              <div className="flex justify-between items-center mb-3">
                  <h3 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-black">Live Sonar Stream</h3>
                  <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                  </div>
              </div>
              
              <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar flex-grow">
                  {scanStream.map((scan, i) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-slate-900/40 rounded border border-white/5 hover:bg-white/[0.02] transition-colors">
                          <div className="flex items-center gap-3">
                              <span className="text-[9px] text-slate-500 font-mono">
                                  {new Date(scan.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                              <span className="text-[10px] font-bold text-slate-300 tracking-wider">
                                  {scan.asset}
                              </span>
                          </div>
                          <div className="flex items-center gap-3">
                              <span className="text-[9px] text-slate-400 font-mono">
                                  MCI: {scan.trigger_mci ? scan.trigger_mci.toFixed(2) : '--'}
                              </span>
                              <span className={`text-[9px] font-black tracking-widest uppercase ${scan.status === 'RESONANT' ? 'text-emerald-400 animate-pulse' : 'text-slate-600'}`}>
                                  {scan.status}
                              </span>
                          </div>
                      </div>
                  ))}
                  {scanStream.length === 0 && (
                      <div className="text-center py-4 text-[9px] text-slate-600 uppercase tracking-widest italic">Awaiting first scan cycle...</div>
                  )}
              </div>
          </div>

        </div>

        {/* CENTER: Chart & Trades (Main View) */}
        <div className="lg:col-span-7 flex flex-col gap-6 h-[calc(100vh-100px)] overflow-hidden">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden min-h-[450px] h-[55%] relative shadow-2xl flex-shrink-0">
            <div id="tv_chart_container" className="absolute inset-0" />
            
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
          <div className="flex-grow overflow-y-auto custom-scrollbar border border-white/5 rounded-[2rem] bg-slate-900/30">
            <table className="w-full text-left table-fixed">
                    <thead className="bg-slate-950/80 text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] sticky top-0 backdrop-blur-md z-10">
                      <tr>
                        <th className="w-[15%] px-4 py-3">Time</th>
                        <th className="w-[20%] px-4 py-3 text-center">Vector</th>
                        <th className="w-[15%] px-4 py-3">Entry</th>
                        <th className="w-[20%] px-4 py-3 text-center">Target (TP / SL)</th>
                        <th className="w-[15%] px-4 py-3">Exit</th>
                        <th className="w-[15%] px-4 py-3 text-right">PnL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                      {tradeLogs.map((log, i) => (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-4 text-[9px] text-slate-500 truncate">
                              {new Date(log.exit_time || log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </td>
                          
                          <td className="px-4 py-4 text-center">
                              <div className="flex flex-col items-center gap-1">
                                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${log.side === 'LONG' || log.side === 'BUY' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                                      {log.side} {log.leverage > 1 ? `${log.leverage}x` : ''}
                                  </span>
                                  <span className="text-[8px] text-slate-600 uppercase font-black tracking-widest">{log.market_type || 'SPOT'}</span>
                              </div>
                          </td>

                          <td className="px-4 py-4 text-slate-300 truncate text-[10px]">${log.entry_price}</td>
                          
                          <td className="px-4 py-4 text-center">
                              {log.tp_price || log.sl_price ? (
                                  <div className="flex flex-col text-[9px]">
                                      <span className="text-emerald-400/70">TP: {log.tp_price ? `$${log.tp_price}` : '--'}</span>
                                      <span className="text-red-400/70">SL: {log.sl_price ? `$${log.sl_price}` : '--'}</span>
                                  </div>
                              ) : (
                                  <span className="text-[9px] text-slate-600 italic">Dynamic</span>
                              )}
                          </td>

                          <td className="px-4 py-4 text-[10px] text-slate-400">
                              {log.exit_price ? `$${log.exit_price}` : <span className="text-indigo-400 animate-pulse font-black text-[9px] uppercase tracking-widest">Active</span>}
                          </td>

                          <td className={`px-4 py-4 text-right font-black ${!log.exit_price ? 'text-slate-600' : (log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}`}>
                              {!log.exit_price ? '--' : `${log.pnl >= 0 ? '+' : ''}$${log.pnl?.toFixed(4)}`}
                          </td>
                        </tr>
                      ))}
                      {tradeLogs.length === 0 && (
                          <tr><td colSpan="6" className="py-20 text-center text-slate-600 italic uppercase text-[10px] tracking-widest">No market activity recorded</td></tr>
                      )}
                    </tbody>
                  </table>
            </div>
        </div>

        {/* RIGHT: Strategy Matrix & Agent (Sidebar) */}
        <div className="lg:col-span-3 flex flex-col gap-6 h-[calc(100vh-100px)] overflow-hidden">
          
          {/* Dynamic Strategy Matrix */}
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2"><Layers size={14} className="text-cyan-400" /> Active Matrix</span>
              <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full">{activeAsset}</span>
            </h3>
            
            <div className="flex flex-col gap-3">
              {currentAssetStrategies.length === 0 && (
                <div className="text-center text-slate-600 italic text-[10px] py-4">No active strategies deployed for this asset. Ask Nexus to deploy one.</div>
              )}
              
              {currentAssetStrategies.map(strat => {
                const stratLogs = tradeLogs;
                const openTrade = stratLogs.find(l => !l.exit_price);
                const totalPnL = stratLogs.reduce((sum, l) => sum + (l.pnl || 0), 0);

                return (
                  <button 
                    key={strat.id} 
                    onClick={() => handleStrategySelect(strat.strategy)}
                    className={`p-4 rounded-2xl border text-left transition-all ${
                      selectedStrat === strat.strategy ? 'bg-indigo-500/10 border-indigo-500/30 ring-1 ring-indigo-500/20' : 'bg-black/20 border-white/5 opacity-80 hover:opacity-100'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-black text-white uppercase tracking-tighter">{strat.strategy}</span>
                      <span className="text-[8px] bg-white/10 px-1.5 py-0.5 rounded text-slate-300">{strat.version || 'v1.0'}</span>
                    </div>
                    
                    {openTrade ? (
                      <div className="flex justify-between items-center text-[10px] font-mono mt-1">
                        <span className="text-slate-500 uppercase">Status: <span className="text-indigo-400 animate-pulse font-bold">IN TRADE ({openTrade.side})</span></span>
                      </div>
                    ) : (
                      <div className="flex justify-between items-center text-[10px] font-mono mt-1">
                        <span className="text-slate-500 uppercase">Net PnL:</span>
                        <span className={`font-black ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Agent Terminal */}
          <div className="bg-slate-950 border border-white/10 rounded-[2.5rem] shadow-2xl flex flex-col flex-grow min-h-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-white/5 bg-slate-900/40 text-[10px] font-black uppercase text-slate-500 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500/40" />
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40" />
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/40" />
              </div>
            </div>
            
            {/* FIX: Chat Window is now perfectly scroll-locked */}
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-4 flex-grow">
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
              <div ref={chatEndRef} className="h-1" />
            </div>

            <form onSubmit={handleSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-3 flex-shrink-0">
              <input
                className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500/50 transition-all"
                value={input} 
                onChange={handleInputChange} 
                placeholder="Query parameters or command deployment..."
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