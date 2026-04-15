import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from '@ai-sdk/react'; 
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Shield, Wallet 
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ASSETS = ['BTC-PERP-INTX', 'ETP-20DEC30-CDE', 'SOL-PERP-INTX', 'DOGE-USD', 'AVAX-PERP-INTX', 'WLD-PERP-INTX', 'XRP-PERP-INTX', 'ADA-PERP-INTX', 'BNB-PERP-INTX'];

export default function Dashboard() {
  const [activeAsset, setActiveAsset] = useState('ETP-20DEC30-CDE');
  const [livePrice, setLivePrice] = useState(0); 
  const [tradeLogs, setTradeLogs] = useState([]);
  const [activeStrategies, setActiveStrategies] = useState([]);
  const [scanStream, setScanStream] = useState([]); 
  const [activeStudies, setActiveStudies] = useState([]);
  const [portfolio, setPortfolio] = useState({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 } });
  const [selectedStrat, setSelectedStrat] = useState(null);
  const [loading, setLoading] = useState(true);
  
  const [livePositions, setLivePositions] = useState([]);
  const [liveOrders, setLiveOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('POSITIONS');

  // THE JAILBREAK: We use our own local state so the SDK cannot freeze the text box!
  const [localInput, setLocalInput] = useState('');

  const { messages, append, error, isLoading } = useChat({
    api: '/api/chat',
    onError: (err) => console.error("[NEXUS AGENT FATAL]:", err)
  });
  const chatEndRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const portResp = await fetch(`/api/portfolio?asset=${activeAsset}`);
      if (portResp.ok) {
        const portData = await portResp.json();
        setPortfolio(portData);
        if (portData.price > 0) setLivePrice(portData.price);
      }
      
      const { data: logs } = await supabase.from('trade_logs').select('*').eq('symbol', activeAsset).order('id', { ascending: false });
      setTradeLogs(logs || []);
      
      const { data: configs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
      setActiveStrategies(configs || []);
      
      const { data: scans } = await supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(15);
      if (scans) setScanStream(scans);

      try {
        const syncResp = await fetch('/api/coinbase-sync');
        if (syncResp.ok) {
          const syncData = await syncResp.json();
          setLivePositions(syncData.positions || []);
          setLiveOrders(syncData.orders || []);
        }
      } catch (syncErr) { console.error("Coinbase Sync failed", syncErr); }

    } catch (e) { console.error(e); } finally { setLoading(false); }
  }, [activeAsset]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (messages.length > 0) {
      const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        const content = lastUserMsg.content.toUpperCase();
        const mentionedAsset = ASSETS.find(asset => content.includes(asset));
        if (mentionedAsset && mentionedAsset !== activeAsset) setActiveAsset(mentionedAsset);
        const mentionedStrat = activeStrategies.find(s => content.includes(s.strategy));
        if (mentionedStrat) {
           const targetStudies = getStudiesForStrategy(mentionedStrat.strategy);
           if (JSON.stringify(targetStudies) !== JSON.stringify(activeStudies)) setActiveStudies(targetStudies);
        }
      }
    }
  }, [messages, activeAsset, activeStrategies, activeStudies]);

  const handleClosePosition = async (trade) => {
    const confirmClose = window.confirm(`Liquidate ${trade.side} position on ${trade.strategy_id || 'Exchange'}?`);
    if (!confirmClose) return;
    const closingSide = (trade.side === 'BUY' || trade.side === 'LONG') ? 'SELL' : 'BUY';
    await fetch('/api/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: trade.symbol, strategy_id: trade.strategy_id || 'MANUAL', version: trade.version || 'v1.0',
        side: closingSide, execution_mode: trade.execution_mode.includes('LIVE') ? 'LIVE' : 'PAPER', qty: trade.qty, price: livePrice 
      })
    });
    fetchData(); 
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!localInput.trim()) return;
    
    const userMsg = localInput;
    setLocalInput(''); // Instantly clears the box
    
    try {
        await append({ role: 'user', content: userMsg });
    } catch (err) {
        console.error("[NEXUS APPEND FAULT]:", err);
    }
  };

  const handleStrategySelect = async (stratId) => {
    setSelectedStrat(stratId);
    try {
        await append({ role: 'user', content: `Brief me on the ${stratId} strategy currently running on ${activeAsset}.` });
    } catch (err) {
        console.error("Append Error:", err);
    }
  };

  const currentAssetStrategies = activeStrategies.filter(s => s.asset === activeAsset);

  const getStudiesForStrategy = (stratName) => {
    if (!stratName) return [];
    const name = stratName.toUpperCase();
    if (name.includes('KELTNER')) return ["KeltnerChannels@tv-basicstudies"];
    if (name.includes('WLD_TREND')) return ["MAExp@tv-basicstudies", "MACD@tv-basicstudies"];
    if (name.includes('SOL_RANGE_REVERSION')) return ["BB@tv-basicstudies", "RSI@tv-basicstudies"];
    if (name.includes('HF_SCALPER')) return ["MASimple@tv-basicstudies", "RSI@tv-basicstudies"];
    if (name.includes('BREAKOUT_SCALPER') || name.includes('BTC_BREAKOUT')) return ["MASimple@tv-basicstudies"];
    if (name.includes('SCALPER')) return ["VWAP@tv-basicstudies", "MASimple@tv-basicstudies"];
    if (name.includes('COHERENCE')) return ["MASimple@tv-basicstudies"]; 
    return [];
  };

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
          "autosize": true, "symbol": `BINANCE:${activeAsset.split('-')[0]}USDT.P`,
          "interval": "1", "theme": "dark", "style": "1", "backgroundColor": "#020617",
          "container_id": "tv_chart_container", "studies": activeStudies 
        });
      }
    };
    container.appendChild(script);
  }, [activeAsset, activeStudies]);

  const paperPositions = tradeLogs.filter(log => !log.exit_price && log.execution_mode === 'PAPER');
  
  const formattedLivePositions = livePositions.map(pos => ({
      side: pos.side === 'LONG' ? 'BUY' : 'SELL',
      entry_price: parseFloat(pos.vwap || 0),
      qty: parseFloat(pos.number_of_contracts || 0),
      symbol: pos.product_id,
      execution_mode: 'LIVE (EXCHANGE)',
      strategy_id: 'ACTIVE_DERIVATIVE',
      pnl: parseFloat(pos.unrealized_pnl || 0),
      created_at: new Date().toISOString()
  }));

  const openPositions = [...formattedLivePositions, ...paperPositions];
  const tradeHistory = tradeLogs.filter(log => log.exit_price);
  
  const openOrders = liveOrders.map(ord => ({
      side: ord.side,
      entry_price: parseFloat(ord.order_configuration?.limit_limit_gtc?.limit_price || 0),
      qty: parseFloat(ord.order_configuration?.limit_limit_gtc?.base_size || 0),
      symbol: ord.product_id,
      execution_mode: 'PENDING_LIMIT',
      strategy_id: 'AWAITING_FILL',
      created_at: ord.created_time || new Date().toISOString()
  }));

  let displayLogs = [];
  if (activeTab === 'POSITIONS') displayLogs = openPositions;
  else if (activeTab === 'TRADE_HISTORY') displayLogs = tradeHistory;
  else if (activeTab === 'OPEN_ORDERS') displayLogs = openOrders;

  if (loading) return <div className="min-h-screen bg-[#020617] flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">Establishing Nexus...</div>;

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 font-sans flex flex-col gap-4">
     <header className="max-w-[1800px] w-full mx-auto flex justify-between items-center border-b border-white/5 pb-4">
        <div className="flex items-center gap-4">
            <h1 className="text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
            <a href="/audit" className="text-[10px] font-black uppercase tracking-widest bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
               <Activity size={12} /> Audit Log
            </a>
        </div>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
      </header>

      <main className="max-w-[1800px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 grow overflow-hidden">
        
        <div className="lg:col-span-2 flex flex-col h-[calc(100vh-100px)] min-h-0 gap-6">
          <div className="bg-slate-900/50 p-5 rounded-[2rem] border border-white/10 flex-shrink-0 shadow-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex justify-between mb-4">Capital Allocation <span className="text-cyan-400 animate-pulse">● LIVE</span></div>
            <div className="space-y-4">
              <div><div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Shield size={10} className="text-emerald-400 inline mr-1"/> Live Equity</div><div className="text-xl font-black font-mono text-white">${portfolio.live?.balance?.toFixed(2) || '0.00'}</div></div>
              <div><div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Cpu size={10} className="text-indigo-400 inline mr-1"/> Nexus Paper</div><div className="text-lg font-black font-mono text-slate-300">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</div></div>
            </div>
          </div>

          <div className="flex flex-col flex-shrink-0">
            <div className="text-[10px] font-black uppercase text-slate-500 mb-3 px-2 tracking-widest flex items-center gap-2"><Target size={12}/> Market Scanners</div>
            <div className="space-y-1 overflow-y-auto max-h-[250px] custom-scrollbar">
              {ASSETS.map(asset => (
                  <button key={asset} onClick={() => setActiveAsset(asset)} className={`w-full text-left px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all ${activeAsset === asset ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}`}>{asset}</button>
              ))}
            </div>
          </div>

          <div className="mt-2 pt-4 border-t border-white/5 flex flex-col min-h-0 flex-grow">
              <h3 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-black mb-3">Live Sonar Stream</h3>
              <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar flex-grow">
              {scanStream.map((scan, i) => (
                      <div key={i} className="flex flex-col p-2 bg-slate-900/40 rounded border border-white/5 hover:bg-white/[0.02] transition-colors gap-1.5">
                          <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                  <span className="text-[9px] text-slate-500 font-mono">{new Date(scan.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                  <span className="text-[10px] font-bold text-slate-300">{scan.asset}</span>
                              </div>
                              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">{scan.strategy}</span>
                          </div>
                         <div className="flex items-center justify-between mt-1 pt-1 border-t border-white/5">
                              <div className="flex flex-wrap gap-x-3 gap-y-1">
                                  {scan.telemetry && Object.entries(scan.telemetry).map(([key, val]) => (
                                      <span key={key} className="text-[9px] text-slate-400 font-mono">
                                        <span className="text-slate-500 uppercase">{key}:</span> 
                                        {typeof val === 'boolean' ? (val ? 'TRUE' : 'FALSE') : (typeof val === 'number' ? val.toFixed(2) : val)}
                                      </span>
                                  ))}
                              </div>
                              <span className={`text-[9px] font-black tracking-widest uppercase flex-shrink-0 ${scan.status === 'RESONANT' ? 'text-emerald-400 animate-pulse' : 'text-slate-600'}`}>{scan.status}</span>
                          </div>
                      </div>
                  ))}
              </div>
          </div>
        </div>

        <div className="lg:col-span-7 flex flex-col gap-6 min-h-0 h-[calc(100vh-100px)]">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden min-h-[450px] h-[55%] relative shadow-2xl flex flex-col p-4">
            <div id="tv_chart_container" className="relative flex-grow w-full h-full z-10" />
            
            <div className="absolute top-6 right-6 z-20 flex flex-col gap-2 max-w-[280px] pointer-events-none">
               {openPositions.slice(0, 3).map((log, i) => {
                 const displayPnl = log.execution_mode.includes('LIVE') ? log.pnl : 
                 ((log.side === 'BUY' || log.side === 'LONG') ? (livePrice - log.entry_price) * (log.qty || 1) : (log.entry_price - livePrice) * (log.qty || 1));
                 return (
                  <div key={i} className="bg-black/70 backdrop-blur-md border border-white/10 p-2 px-3 rounded-xl text-[9px] font-mono flex items-center justify-between gap-4 pointer-events-auto shadow-lg">
                     <div className="flex flex-col gap-0.5">
                       <div className="flex items-center gap-2">
                         <span className={log.side === 'BUY' || log.side === 'LONG' ? 'text-emerald-400 animate-pulse' : 'text-amber-400 animate-pulse'}>●</span>
                         <span className="text-slate-300 uppercase font-bold">{log.side} {log.qty ? `(${log.qty.toLocaleString()})` : ''} @ {log.entry_price}</span>
                       </div>
                       <div className="flex items-center gap-3">
                         <span className="text-[7px] text-slate-500 font-black tracking-widest uppercase pl-3">{log.strategy_id}</span>
                       </div>
                     </div>
                     {livePrice > 0 && (
                         <span className={`font-black ${displayPnl >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>
                             {displayPnl >= 0 ? '+' : ''}{displayPnl?.toFixed(4)}
                         </span>
                     )}
                  </div>
                 )
               })}
            </div>
          </div>

          <div className="flex flex-col flex-grow overflow-hidden border border-white/5 rounded-[2rem] bg-slate-900/30">
            <div className="flex items-center gap-6 px-6 pt-5 border-b border-white/5 bg-slate-950/80 sticky top-0 z-20">
               <button 
                  onClick={() => setActiveTab('OPEN_ORDERS')} 
                  className={`pb-3 text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'OPEN_ORDERS' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Open Orders {openOrders.length > 0 && <span className="ml-1 bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded-full text-[8px]">{openOrders.length}</span>}
               </button>
               <button 
                  onClick={() => setActiveTab('POSITIONS')} 
                  className={`pb-3 text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'POSITIONS' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Positions {openPositions.length > 0 && <span className="ml-1 bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded-full text-[8px]">{openPositions.length}</span>}
               </button>
               <button 
                  onClick={() => setActiveTab('TRADE_HISTORY')} 
                  className={`pb-3 text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'TRADE_HISTORY' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Trade History
               </button>
            </div>

            <div className="overflow-y-auto custom-scrollbar flex-grow">
              {displayLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12">
                  <Layers size={24} className="mb-2 opacity-50" />
                  <p className="text-[11px] font-bold uppercase tracking-widest">No data available</p>
                  <p className="text-[9px] font-mono mt-1 opacity-60">
                    {activeTab === 'OPEN_ORDERS' ? "Your pending limit orders will appear here" : "Completed trades will appear here"}
                  </p>
                </div>
              ) : (
                <table className="w-full text-left table-fixed">
                      <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-widest sticky top-0 backdrop-blur-md z-10">
                        <tr>
                          <th className="px-4 py-3">Date / Time</th>
                          <th className="px-4 py-3 text-center">Strategy</th>
                          <th className="px-4 py-3 text-center">Vector</th>
                          <th className="px-4 py-3 text-center">Size</th>
                          <th className="px-4 py-3">Entry/Price</th>
                          <th className="px-4 py-3 text-center">Target (TP / SL)</th>
                          <th className="px-4 py-3">Status/Exit</th>
                          <th className="px-4 py-3 text-right">PnL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                        {displayLogs.map((log, i) => {
                          let pnlDisplay = '--';
                          if (log.exit_price) {
                              pnlDisplay = <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)}</span>;
                          } else if (log.execution_mode === 'LIVE (EXCHANGE)') {
                              pnlDisplay = <span className={log.pnl >= 0 ? 'text-cyan-400 animate-pulse' : 'text-amber-400 animate-pulse'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)} (U)</span>;
                          } else if (livePrice > 0 && activeTab === 'POSITIONS') {
                              const paperPnl = (log.side === 'BUY' ? livePrice - log.entry_price : log.entry_price - livePrice) * (log.qty || 1);
                              pnlDisplay = <span className={`animate-pulse ${paperPnl >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>${paperPnl.toFixed(4)} (U)</span>;
                          }
                          
                          const timestamp = log.created_at || log.exit_time;
                          const formattedDate = timestamp ? new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : "Awaiting...";
                          const formattedTime = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";

                          const isLiveExchange = log.execution_mode && log.execution_mode.includes('LIVE');
                          
                          return (
                          <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-4 text-[9px] text-slate-500">
                                <div className="flex flex-col">
                                    <span className="font-bold text-slate-400">{formattedDate}</span>
                                    <span className="text-[8px] opacity-60">{formattedTime}</span>
                                </div>
                            </td>
                            <td className="px-4 py-4 text-center">
                                <span className={`text-[9px] font-black uppercase px-2 py-1 rounded border flex flex-col items-center ${isLiveExchange ? 'bg-cyan-500/5 text-cyan-300 border-cyan-500/10' : 'bg-indigo-500/5 text-indigo-300/80 border-indigo-500/10'}`}>
                                    {log.strategy_id?.replace('_V1', '')}
                                    {log.reason && <span className="text-[7px] text-slate-500 tracking-tighter mt-1 block truncate max-w-[80px]" title={log.reason}>Oracle Auth</span>}
                                </span>
                            </td>
                            <td className="px-4 py-4 text-center"><span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${log.side === 'BUY' || log.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>{log.side}</span></td>
                            
                            <td className="px-4 py-4 text-center text-[10px] text-slate-300">
                                {log.qty ? log.qty.toLocaleString() : '--'}
                            </td>

                            <td className="px-4 py-4 text-slate-300 text-[10px]">${log.entry_price}</td>
                            <td className="px-4 py-4 text-center">
                                {log.tp_price || log.sl_price ? (
                                    <div className="flex flex-col text-[8px] tracking-tighter uppercase">
                                        <span className="text-emerald-500/60">TP: ${log.tp_price}</span>
                                        <span className="text-red-500/60">SL: ${log.sl_price}</span>
                                    </div>
                                ) : <span className="text-slate-700 italic text-[9px]">Dynamic</span>}
                            </td>
                            <td className="px-4 py-4 flex items-center gap-2">
                                {log.exit_price ? `$${log.exit_price}` : 
                                 <><span className="text-indigo-400 animate-pulse font-black text-[9px]">{log.execution_mode.includes('PENDING') ? 'PENDING' : 'ACTIVE'}</span> 
                                 <button onClick={() => handleClosePosition(log)} className="bg-red-500/10 text-red-400 border border-red-500/30 px-2 py-0.5 rounded text-[8px] font-black">CLOSE</button></>}
                            </td>
                            <td className="px-4 py-4 text-right font-black text-[10px]">{pnlDisplay}</td>
                          </tr>
                        )})}
                      </tbody>
                    </table>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6 h-[calc(100vh-100px)] overflow-hidden">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center justify-between"><span>Active Matrix</span><span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full">{activeAsset}</span></h3>
            <div className="flex flex-col gap-3">
              {currentAssetStrategies.map(strat => {
                const stratLogs = tradeLogs.filter(l => l.strategy_id === strat.strategy);
                const totalPnL = stratLogs.reduce((sum, l) => sum + (l.pnl || 0), 0);
                return (
                  <button key={strat.id} onClick={() => handleStrategySelect(strat.strategy)} className="p-4 rounded-2xl border bg-black/20 border-white/5 text-left transition-all hover:bg-white/5">
                    <div className="flex justify-between items-center mb-1"><span className="text-xs font-black text-white uppercase">{strat.strategy}</span><button onClick={(e) => { e.stopPropagation(); setActiveStudies(getStudiesForStrategy(strat.strategy)); }} className="text-[8px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 rounded">+ CHART</button></div>
                    <div className="text-[10px] text-slate-500 font-mono">Net PnL: <span className={totalPnL >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>${totalPnL.toFixed(2)}</span></div>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="bg-slate-950 border border-white/10 rounded-[2.5rem] flex flex-col flex-grow overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-4 flex-grow">
              
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${m.role === 'user' ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' : 'bg-slate-900/80 text-cyan-400 border border-white/5'}`}>
                        {m.content}
                    </div>
                </div>
              ))}
              
              {error && (
                <div className="flex justify-start">
                    <div className="max-w-[90%] rounded-2xl px-4 py-3 bg-red-500/10 text-red-400 border border-red-500/20">
                        [SYSTEM FAULT]: {error.message}
                    </div>
                </div>
              )}
              
              <div ref={chatEndRef} />
            </div>

            {/* THE JAILBREAK: Replaced internal input state with local state, removed all disabled tags! */}
            <form onSubmit={handleManualSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-3">
                <input 
                  className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white focus:outline-none focus:border-indigo-500/50" 
                  value={localInput} 
                  onChange={(e) => setLocalInput(e.target.value)} 
                  placeholder="Command Nexus..." 
              />
              <button 
                  type="submit" 
                  disabled={!localInput.trim()}
                  className={`border rounded-xl px-4 py-3 transition-all flex items-center justify-center min-w-[50px] ${isLoading ? 'bg-indigo-500/40 border-indigo-500/50 text-indigo-200 animate-pulse' : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/30'}`}
              >
                  {isLoading ? <span className="text-[10px] font-black tracking-widest">...</span> : <Send size={16} />}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}