import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useChat } from '@ai-sdk/react'; 
import Link from 'next/link'; 
import { createChart, CrosshairMode, CandlestickSeries, createSeriesMarkers, HistogramSeries } from 'lightweight-charts';
import { 
  Database, BarChart3, Clock, Cpu, Terminal as TerminalIcon, 
  Send, Activity, Layers, TrendingUp, Target, Shield, Wallet,
  Eye, Zap, AlertOctagon, BarChart2, Search, Maximize2, Minimize2, Flame, Power, AlertTriangle
} from 'lucide-react';

// 🟢 THE NUCLEAR FIX: Global Polyfill for crypto.randomUUID to prevent StackBlitz iframe crashes
if (typeof window !== 'undefined') {
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) {
        window.crypto.randomUUID = () => {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        };
    }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MASTER_ASSETS = [
    'BTC-PERP-INTX', 'ETH-PERP-INTX', 'ETP-20DEC30-CDE', 'SOL-PERP-INTX', 
    'DOGE-PERP-INTX', 'AVP-20DEC30-CDE', 'WLD-PERP-INTX', 'XRP-PERP-INTX', 
    'ADA-PERP-INTX', 'BNB-PERP-INTX', 'LINK-PERP-INTX', 'MATIC-PERP-INTX',
    'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX', 'APT-PERP-INTX',
    'SLP-20DEC30-CDE'
];

export default function Dashboard() {
  const [assetsList, setAssetsList] = useState(['ETP-20DEC30-CDE', 'BTC-PERP-INTX', 'SOL-PERP-INTX', 'SLP-20DEC30-CDE']);
  const [searchAsset, setSearchAsset] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  
  const [activeAsset, setActiveAsset] = useState('ETP-20DEC30-CDE');
  const [livePrice, setLivePrice] = useState(0); 
  const [tradeLogs, setTradeLogs] = useState([]);
  const [activeStrategies, setActiveStrategies] = useState([]);
  const [scanStream, setScanStream] = useState([]); 
  const [portfolio, setPortfolio] = useState({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 } });
  const [loading, setLoading] = useState(true);
  
  const [livePositions, setLivePositions] = useState([]);
  const [liveOrders, setLiveOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('POSITIONS');
  
  const [isChartMaximized, setIsChartMaximized] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [isDefconActive, setIsDefconActive] = useState(false);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const seriesMarkersRef = useRef(null); 
  const priceLinesRef = useRef([]);
  const [chartTimeframe, setChartTimeframe] = useState('1m');

  const [localInput, setLocalInput] = useState('');

  // 🟢 We can now use the standard hook, as the polyfill protects it globally
  const { messages, append, error: sdkError, isLoading } = useChat({
    api: '/api/chat',
    onError: (err) => console.error("[NEXUS AGENT FATAL]:", err)
  });
  
  const chatEndRef = useRef(null);

  useEffect(() => {
      const checkDefconTime = () => {
          const now = new Date();
          const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
          const centralHour = parseInt(formatter.format(now), 10);
          setIsDefconActive(centralHour === 14); 
      };
      
      checkDefconTime();
      const defconInterval = setInterval(checkDefconTime, 60000); 
      return () => clearInterval(defconInterval);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [logsRes, configsRes, scansRes] = await Promise.all([
          supabase.from('trade_logs').select('*').eq('symbol', activeAsset).order('id', { ascending: false }),
          supabase.from('strategy_config').select('*'),
          supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(25)
      ]);

      setTradeLogs(logsRes.data || []);
      setActiveStrategies(configsRes.data || []);
      setScanStream(scansRes.data || []);
      
      setLoading(false); 

      fetch(`/api/portfolio?asset=${activeAsset}`)
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setPortfolio(data);
                  if (data.price > 0) setLivePrice(data.price);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Portfolio API delayed:", e.message));

      fetch('/api/coinbase-sync')
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setLivePositions(data.positions || []);
                  setLiveOrders(data.orders || []);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Exchange API delayed:", e.message));

    } catch (e) { 
      console.error("[NEXUS FATAL] DB Fetch Error:", e); 
      setLoading(false); 
    }
  }, [activeAsset]);

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => {
     const dbAssets = new Set([...assetsList, ...tradeLogs.map(l => l.symbol), ...activeStrategies.map(s => s.asset)]);
     const uniqueAssets = Array.from(dbAssets).filter(Boolean);
     if (uniqueAssets.length > assetsList.length) setAssetsList(uniqueAssets);
  }, [tradeLogs, activeStrategies, assetsList]);

  const handleAddAsset = (assetToAdd) => {
      const newAsset = assetToAdd.trim().toUpperCase();
      if(newAsset && !assetsList.includes(newAsset)) {
          setAssetsList(prev => [newAsset, ...prev]);
      }
      setActiveAsset(newAsset);
      setSearchAsset('');
      setIsSearching(false);
  };

  const handleToggleStrategy = async (strategyId, currentState) => {
      try {
          await supabase.from('strategy_config').update({ is_active: !currentState }).eq('strategy', strategyId);
          fetchData(); 
      } catch (err) {
          console.error("Failed to toggle strategy:", err);
      }
  };

  const filteredSearch = MASTER_ASSETS.filter(a => a.toLowerCase().includes(searchAsset.toLowerCase()));

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

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

  const handleCancelOrder = async (order) => {
      const confirmCancel = window.confirm(`Cancel pending ${order.side} limit order for ${order.symbol}?`);
      if (!confirmCancel) return;
      
      try {
          await fetch('/api/cancel-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order_ids: [order.order_id] })
          });
          fetchData(); 
      } catch (e) {
          console.error("Cancel Order Failed:", e);
      }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!localInput?.trim() || isLoading) return;
    
    const content = localInput;
    setLocalInput(''); 
    
    try {
        await append({ role: 'user', content });
    } catch (err) {
        console.error("Append Fault:", err);
    }
  };

  const handleStrategySelect = async (stratId) => {
    await append({ role: 'user', content: `Brief me on the ${stratId} strategy currently running on ${activeAsset}.` });
  };

  const currentAssetStrategies = activeStrategies.filter(s => s.asset === activeAsset);

  const paperPositions = useMemo(() => tradeLogs.filter(log => !log.exit_price && log.execution_mode === 'PAPER'), [tradeLogs]);
  
  const formattedLivePositions = useMemo(() => livePositions.map(pos => ({
      side: pos.side === 'LONG' ? 'BUY' : 'SELL',
      entry_price: parseFloat(pos.vwap || 0),
      qty: parseFloat(pos.number_of_contracts || 0),
      symbol: pos.product_id,
      execution_mode: 'LIVE (EXCHANGE)',
      strategy_id: 'ACTIVE_DERIVATIVE',
      pnl: parseFloat(pos.unrealized_pnl || 0),
      created_at: new Date().toISOString(),
      reason: ''
  })), [livePositions]);

  const openPositions = useMemo(() => [...formattedLivePositions, ...paperPositions], [formattedLivePositions, paperPositions]);
  const tradeHistory = useMemo(() => tradeLogs.filter(log => log.exit_price), [tradeLogs]);
  
  const openOrders = useMemo(() => liveOrders.map(ord => ({
      order_id: ord.order_id, 
      side: ord.side,
      entry_price: parseFloat(ord.order_configuration?.limit_limit_gtc?.limit_price || 0),
      qty: parseFloat(ord.order_configuration?.limit_limit_gtc?.base_size || 0),
      symbol: ord.product_id,
      execution_mode: 'PENDING_LIMIT',
      strategy_id: 'AWAITING_FILL',
      created_at: ord.created_time || new Date().toISOString()
  })), [liveOrders]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    
    const chart = createChart(chartContainerRef.current, {
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        crosshair: { mode: CrosshairMode.Normal },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(255,255,255,0.1)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
        autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#10b981', wickDownColor: '#ef4444'
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        visible: showHeatmap, 
    });
    
    chart.priceScale('').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
    });

    const markersPlugin = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volumeSeries;
    seriesMarkersRef.current = markersPlugin; 

    const handleResize = () => {
        if(chartContainerRef.current) {
            chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });
        }
    };
    
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
        resizeObserver.disconnect();
        chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  useEffect(() => {
    let isMounted = true;
    let intervalId;

    const loadChartData = async (isLiveTick = false) => {
        if(!seriesRef.current || !volumeSeriesRef.current) return;

        const tfMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
        const granularity = tfMap[chartTimeframe] || 60;

        try {
            const res = await fetch(`/api/chart-data?asset=${activeAsset}&granularity=${granularity}&limit=1500&deepCache=true`);
            if(!res.ok) throw new Error("Chart proxy failed");
            
            const data = await res.json();
            if(!isMounted) return;

            if (!Array.isArray(data) || data.length === 0) return;

            if (isLiveTick) {
                const latestCandle = data[data.length - 1];
                seriesRef.current.update(latestCandle);
                
                volumeSeriesRef.current.update({
                    time: latestCandle.time,
                    value: latestCandle.volume,
                    color: latestCandle.close >= latestCandle.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                });
            } else {
                seriesRef.current.setData(data);
                
                const volumeData = data.map(c => ({
                    time: c.time,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                }));
                volumeSeriesRef.current.setData(volumeData);
            }
        } catch(e) { console.error("Chart Fetch Error:", e); }
    };

    loadChartData(false); 
    intervalId = setInterval(() => loadChartData(true), 3000);

    return () => { 
        isMounted = false; 
        clearInterval(intervalId); 
    };
  }, [activeAsset, chartTimeframe]);

  useEffect(() => {
      if (volumeSeriesRef.current) {
          volumeSeriesRef.current.applyOptions({ visible: showHeatmap });
      }
  }, [showHeatmap]);

  useEffect(() => {
      if(!seriesRef.current || !seriesMarkersRef.current) return;

      try {
          const markers = [];
          const secondsMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
          const granularity = secondsMap[chartTimeframe] || 60;
          
          const currentData = seriesRef.current.data();
          if (!currentData || currentData.length === 0) return;
          
          const candleTimesArray = currentData.map(c => c.time);
          const usedTimes = new Set();
          
          [...tradeLogs].reverse().forEach(log => {
              if (log.created_at) {
                  let rawTime = Math.floor(new Date(log.created_at).getTime() / 1000);
                  let snappedTime = candleTimesArray.reduce((prev, curr) => 
                      Math.abs(curr - rawTime) < Math.abs(prev - rawTime) ? curr : prev
                  );
                  
                  if (Math.abs(snappedTime - rawTime) <= granularity * 2) {
                      while(usedTimes.has(snappedTime)) snappedTime++; 
                      usedTimes.add(snappedTime);

                      const isBuy = log.side === 'BUY' || log.side === 'LONG';
                      const isShadow = log.execution_mode === 'SHADOW';

                      markers.push({
                          time: snappedTime,
                          position: isBuy ? 'belowBar' : 'aboveBar',
                          color: isShadow ? '#64748b' : (isBuy ? '#10b981' : '#ef4444'),
                          shape: isBuy ? 'arrowUp' : 'arrowDown',
                          text: isShadow ? '👻 VETO' : (isBuy ? 'BUY' : 'SELL')
                      });
                  }
              }

              if (log.exit_time && log.execution_mode !== 'SHADOW') {
                  let rawExitTime = Math.floor(new Date(log.exit_time).getTime() / 1000);
                  let snappedExitTime = candleTimesArray.reduce((prev, curr) => 
                      Math.abs(curr - rawExitTime) < Math.abs(prev - rawExitTime) ? curr : prev
                  );

                  if (Math.abs(snappedExitTime - rawExitTime) <= granularity * 2) {
                      while(usedTimes.has(snappedExitTime)) snappedExitTime++; 
                      usedTimes.add(snappedExitTime);

                      const isBuy = log.side === 'BUY' || log.side === 'LONG';
                      const exitPosition = isBuy ? 'aboveBar' : 'belowBar';
                      const exitShape = isBuy ? 'arrowDown' : 'arrowUp';
                      
                      let text = 'CLOSE';
                      let color = '#94a3b8'; 
                      const reason = log.reason || '';

                      if (reason.includes('REVERSAL')) {
                          text = '⚡ REVERSAL'; color = '#a855f7';
                      } else if (reason.includes('TRIPWIRE')) {
                          text = '🛡️ TRIPWIRE'; color = '#f59e0b';
                      } else if (reason.includes('TAKE_PROFIT') || (log.pnl > 0 && !reason.includes('STOP_LOSS'))) {
                          text = '🎯 TP'; color = '#10b981';
                      } else if (reason.includes('STOP_LOSS') || log.pnl < 0) {
                          text = '🛑 SL'; color = '#ef4444';
                      }

                      markers.push({
                          time: snappedExitTime,
                          position: exitPosition,
                          color: color,
                          shape: exitShape,
                          text: text
                      });
                  }
              }
          });

          markers.sort((a,b) => a.time - b.time);
          seriesMarkersRef.current.setMarkers(markers);

          priceLinesRef.current.forEach(line => seriesRef.current.removePriceLine(line));
          priceLinesRef.current = [];

          openPositions.forEach(pos => {
              if(pos.entry_price) {
                  const el = seriesRef.current.createPriceLine({ price: pos.entry_price, color: '#6366f1', lineWidth: 2, lineStyle: 0, title: `${pos.side} AVG` });
                  priceLinesRef.current.push(el);
              }
              if(pos.tp_price) {
                  const tl = seriesRef.current.createPriceLine({ price: pos.tp_price, color: '#10b981', lineWidth: 2, lineStyle: 2, title: 'TP' });
                  priceLinesRef.current.push(tl);
              }
              if(pos.sl_price) {
                  const sl = seriesRef.current.createPriceLine({ price: pos.sl_price, color: '#ef4444', lineWidth: 2, lineStyle: 2, title: 'SL' });
                  priceLinesRef.current.push(sl);
              }
          });

      } catch (err) {
          console.error("Marker Drawing Error:", err);
      }
  }, [tradeLogs, openPositions, activeAsset, chartTimeframe]);

  const activeAssetScans = scanStream.filter(s => s.asset === activeAsset);
  const latestScan = activeAssetScans.length > 0 ? activeAssetScans[0] : null;

  const bids = parseFloat(latestScan?.telemetry?.bids || 0);
  const asks = parseFloat(latestScan?.telemetry?.asks || 0);
  const cvd = parseFloat(latestScan?.telemetry?.cvd || 0);
  const totalLiquidity = bids + asks;
  const targetPercent = totalLiquidity > 0 ? (bids / totalLiquidity) * 100 : 50;

  const [liveBidPercent, setLiveBidPercent] = useState(50);

  useEffect(() => {
      setLiveBidPercent(targetPercent); 
      
      if (totalLiquidity === 0) return; 

      const jitterInterval = setInterval(() => {
          const microJitter = (Math.random() - 0.5) * 2; 
          setLiveBidPercent(prev => Math.max(1, Math.min(99, targetPercent + microJitter)));
      }, 1200);

      return () => clearInterval(jitterInterval);
  }, [targetPercent, totalLiquidity]);

  const isVeto = latestScan?.status === 'ORACLE VETO';
  const isResonant = latestScan?.status === 'RESONANT';
  const isExchangeActive = openPositions.length > 0 || openOrders.length > 0;

  let displayLogs = [];
  if (activeTab === 'POSITIONS') displayLogs = openPositions;
  else if (activeTab === 'TRADE_HISTORY') displayLogs = tradeHistory;
  else if (activeTab === 'OPEN_ORDERS') displayLogs = openOrders;


  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 font-sans flex flex-col gap-4 relative">
      
      {isDefconActive && (
          <div className="bg-red-500/20 border-b border-red-500/50 text-red-200 px-6 py-3 flex items-center justify-center gap-3 w-full animate-pulse z-50">
              <AlertTriangle size={18} className="text-red-400" />
              <span className="text-[11px] font-black uppercase tracking-widest">
                  DEFCON 3: OVERNIGHT MARGIN SWEEP APPROACHING. VERIFY CAPITAL OR FLATTEN OPEN DERIVATIVE POSITIONS.
              </span>
          </div>
      )}

      {loading && (
         <div className="absolute inset-0 z-50 bg-[#020617]/90 backdrop-blur-sm flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">
             Establishing Nexus...
         </div>
      )}

      <header className="max-w-[1800px] w-full mx-auto flex justify-between items-center border-b border-white/5 pb-4">
        <div className="flex items-center gap-4">
            <h1 className="text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Command</h1>
            <Link href="/audit" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
               <Activity size={12} /> Audit Log
            </Link>
            <Link href="/performance" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
               <BarChart3 size={12} /> Performance
            </Link>
        </div>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Database size={12} /> Sync: wsrioyxzhxxrtzjncfvn</div>
      </header>

      <main className="max-w-[1800px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 grow overflow-hidden">
        
        <div className="lg:col-span-2 flex flex-col h-[calc(100vh-100px)] min-h-0 gap-6 resize-y overflow-auto pb-4">
          <div className="bg-slate-900/50 p-5 rounded-[2rem] border border-white/10 flex-shrink-0 shadow-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex justify-between mb-4">Capital Allocation <span className="text-cyan-400 animate-pulse">● LIVE</span></div>
            <div className="space-y-4">
              <div><div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Shield size={10} className="text-emerald-400 inline mr-1"/> Live Equity</div><div className="text-xl font-black font-mono text-white">${portfolio.live?.balance?.toFixed(2) || '0.00'}</div></div>
              <div><div className="text-[9px] text-slate-400 uppercase font-bold flex items-center gap-1 mb-1"><Cpu size={10} className="text-indigo-400 inline mr-1"/> Nexus Paper</div><div className="text-lg font-black font-mono text-slate-300">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</div></div>
            </div>
          </div>

          <div className="flex flex-col flex-shrink-0">
            <div className="text-[10px] font-black uppercase text-slate-500 mb-3 px-2 tracking-widest flex items-center gap-2"><Target size={12}/> Market Scanners</div>
            
            <div className="mb-3 px-1 relative">
                <form onSubmit={(e) => { e.preventDefault(); handleAddAsset(searchAsset); }} className="relative">
                    <input 
                        type="text" 
                        value={searchAsset}
                        onChange={(e) => { setSearchAsset(e.target.value); setIsSearching(true); }}
                        onFocus={() => setIsSearching(true)}
                        placeholder="Search Asset..."
                        className="w-full bg-black/50 border border-white/10 rounded-xl pl-8 pr-3 py-2 text-[10px] font-mono text-white focus:outline-none focus:border-indigo-500/50 uppercase relative z-20"
                    />
                    <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 z-20" />
                </form>
                
                {isSearching && searchAsset && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-white/10 rounded-xl overflow-hidden z-30 shadow-2xl">
                        {filteredSearch.map(asset => (
                            <button 
                                key={asset} 
                                type="button"
                                onClick={() => handleAddAsset(asset)}
                                className="w-full text-left px-4 py-2 text-[10px] font-mono text-white hover:bg-indigo-500/30 transition-colors uppercase"
                            >
                                {asset}
                            </button>
                        ))}
                        {filteredSearch.length === 0 && <div className="px-4 py-2 text-[10px] text-slate-500 italic">No assets found</div>}
                    </div>
                )}
            </div>

            <div className="space-y-1 overflow-y-auto max-h-[250px] custom-scrollbar px-1">
              {assetsList.map(asset => (
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
                              <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">{scan.strategy.replace('_V1', '')}</span>
                          </div>
                         <div className="flex items-center justify-between mt-1 pt-1 border-t border-white/5">
                              <div className="flex flex-wrap gap-x-3 gap-y-1">
                                  <span className="text-[9px] text-slate-400 font-mono">
                                    <span className="text-slate-500 uppercase">CVD:</span> {parseFloat(scan.telemetry?.cvd || 0).toFixed(0)}
                                  </span>
                                  <span className="text-[9px] text-slate-400 font-mono">
                                    <span className="text-slate-500 uppercase">SCORE:</span> {scan.telemetry?.oracle_score || '--'}
                                  </span>
                              </div>
                              <span className={`text-[9px] font-black tracking-widest uppercase flex-shrink-0 ${scan.status === 'RESONANT' ? 'text-emerald-400 animate-pulse' : (scan.status === 'ORACLE VETO' ? 'text-red-400' : 'text-slate-600')}`}>{scan.status}</span>
                          </div>
                      </div>
                  ))}
              </div>
          </div>
        </div>

        <div className="lg:col-span-7 flex flex-col gap-6 min-h-0 h-[calc(100vh-100px)]">
          
          <div className="bg-slate-900/50 border border-white/10 rounded-3xl p-4 flex flex-col gap-4 shadow-xl relative overflow-hidden flex-shrink-0">
            <div className={`absolute inset-0 opacity-10 transition-colors duration-1000 ${isVeto ? 'bg-red-500' : (isResonant ? 'bg-emerald-500' : 'bg-indigo-500')} animate-pulse`} />
            
            <div className="relative z-10 flex items-center justify-between px-4">
               <div className="flex flex-col items-center gap-2 w-20">
                  <div className="w-10 h-10 rounded-full bg-indigo-500/20 border border-indigo-500/50 flex items-center justify-center text-indigo-400 shadow-[0_0_15px_-3px_rgba(99,102,241,0.4)]">
                      <Target size={16} className="animate-spin-slow" />
                  </div>
                  <span className="text-[9px] font-black uppercase tracking-widest text-indigo-300">Scanner</span>
               </div>
               
               <div className="flex-1 h-[2px] bg-indigo-500/20 relative overflow-hidden rounded-full mx-2">
                  <div className="absolute inset-0 bg-indigo-500/50 w-full animate-pulse" />
               </div>
               
               <div className="flex flex-col items-center gap-2 w-20">
                  <div className={`w-10 h-10 rounded-full border flex items-center justify-center transition-all duration-500 ${isVeto ? 'bg-red-500/20 border-red-500/50 text-red-400 shadow-[0_0_15px_-3px_rgba(239,68,68,0.4)]' : (isResonant ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_-3px_rgba(16,185,129,0.4)]' : 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 animate-pulse')}`}>
                      {isVeto ? <AlertOctagon size={16} /> : <Cpu size={16} />}
                  </div>
                  <span className={`text-[9px] font-black uppercase tracking-widest ${isVeto ? 'text-red-400' : 'text-cyan-300'}`}>Oracle</span>
               </div>
               
               <div className="flex-1 h-[2px] bg-slate-800 relative overflow-hidden rounded-full mx-2">
                  <div className={`absolute inset-0 transition-all duration-1000 ${isResonant || isExchangeActive ? 'bg-emerald-500/50 w-full animate-pulse' : 'w-0'}`} />
               </div>
               
               <div className="flex flex-col items-center gap-2 w-20">
                  <div className={`w-10 h-10 rounded-full border flex items-center justify-center transition-all duration-500 ${isExchangeActive ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_-3px_rgba(16,185,129,0.4)]' : 'bg-slate-900 border-white/10 text-slate-600'}`}>
                      <Zap size={16} className={isExchangeActive ? 'animate-pulse' : ''} />
                  </div>
                  <span className={`text-[9px] font-black uppercase tracking-widest ${isExchangeActive ? 'text-emerald-300' : 'text-slate-500'}`}>Exchange</span>
               </div>
            </div>

            <div className="relative z-10 grid grid-cols-3 gap-4 pt-4 border-t border-white/5">
                <div className="col-span-1 flex flex-col gap-2">
                    <div className="text-[8px] font-black tracking-widest uppercase text-slate-500 flex items-center justify-between mb-1">
                        <span className="flex items-center gap-1"><Eye size={10}/> Order Book Heatmap</span>
                        <span className={`font-mono ${cvd !== 0 ? (cvd > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}>CVD: {cvd.toFixed(0)}</span>
                    </div>
                    {totalLiquidity > 0 ? (
                        <div className="w-full h-2 rounded-full overflow-hidden flex bg-slate-800">
                            <div style={{ width: `${liveBidPercent}%` }} className="h-full bg-emerald-500/80 transition-all duration-500 ease-linear" />
                            <div style={{ width: `${100 - liveBidPercent}%` }} className="h-full bg-red-500/80 transition-all duration-500 ease-linear" />
                        </div>
                    ) : <div className="text-[10px] font-mono text-slate-600">Awaiting Depth...</div>}
                    <div className="flex justify-between text-[8px] font-mono text-slate-400">
                        <span className="text-emerald-400">BIDS: {bids.toFixed(0)}</span>
                        <span className="text-red-400">ASKS: {asks.toFixed(0)}</span>
                    </div>
                </div>
                <div className="col-span-2 bg-black/40 rounded-lg p-2 border border-white/5 h-20 overflow-y-auto custom-scrollbar">
                    <div className="text-[8px] font-black tracking-widest uppercase text-indigo-400 mb-1 flex items-center gap-1"><TerminalIcon size={10}/> Oracle Reasoning</div>
                    <div className="text-[9px] font-mono text-slate-300 leading-relaxed italic">
                        {latestScan?.telemetry?.oracle_reasoning || "Awaiting structural anomaly detection..."}
                    </div>
                </div>
            </div>
          </div>

          <div className={isChartMaximized ? "fixed inset-4 z-[100] bg-[#020617] border border-indigo-500/50 rounded-3xl p-6 shadow-2xl flex flex-col transition-all" : "bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden min-h-[300px] flex-grow relative shadow-2xl flex flex-col resize-y transition-all"}>
            
            <button onClick={() => setIsChartMaximized(!isChartMaximized)} className="absolute top-4 right-4 z-50 bg-black/40 hover:bg-indigo-500/20 text-slate-400 hover:text-indigo-300 border border-white/10 hover:border-indigo-500/50 p-2 rounded-lg transition-colors backdrop-blur-md">
                {isChartMaximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}
            </button>

            <div className="absolute top-4 left-6 z-20 flex gap-2 items-center">
                {['1m', '5m', '15m', '1h', '4h'].map(tf => (
                    <button 
                        key={tf} 
                        onClick={() => setChartTimeframe(tf)}
                        className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-lg border transition-all ${chartTimeframe === tf ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-slate-950/80 text-slate-500 border-white/5 hover:bg-white/5'}`}
                    >
                        {tf}
                    </button>
                ))}
                
                <button 
                    onClick={() => setShowHeatmap(!showHeatmap)}
                    className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-lg border transition-all flex items-center gap-1 ${showHeatmap ? 'bg-amber-500/30 text-amber-300 border-amber-500/50 shadow-[0_0_10px_-2px_rgba(245,158,11,0.4)]' : 'bg-slate-950/80 text-slate-500 border-white/5 hover:bg-amber-500/10'}`}
                >
                    <Flame size={12} className={showHeatmap ? 'text-amber-400 animate-pulse' : 'text-slate-500'} />
                    Heatmap {showHeatmap ? 'ON' : 'OFF'}
                </button>
            </div>

            <div className="absolute top-16 right-6 z-20 flex flex-col gap-2 max-w-[280px] pointer-events-none">
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

            <div className="flex-grow w-full relative mt-12 mb-4 px-2 min-h-[300px]">
                <div ref={chartContainerRef} className="absolute inset-0" />
            </div>
          </div>

          <div className="flex flex-col h-[35%] overflow-hidden border border-white/5 rounded-[2rem] bg-slate-900/30 resize-y pb-2">
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
                </div>
              ) : (
                <table className="w-full text-left table-fixed">
                      <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-widest sticky top-0 backdrop-blur-md z-10">
                        <tr>
                          <th className="px-4 py-3 w-24">Date</th>
                          <th className="px-4 py-3 text-center">Context</th>
                          <th className="px-4 py-3 text-center w-20">Vector</th>
                          <th className="px-4 py-3 text-center">Entry</th>
                          <th className="px-4 py-3 text-center">Targets</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3 text-right">PnL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 font-mono text-xs text-slate-400">
                        {displayLogs.map((log, i) => {
                          const isShadow = log.execution_mode === 'SHADOW';
                          const isReversal = log.reason && log.reason.includes('[REVERSAL');
                          const isTripwire = log.reason && log.reason.includes('[TRIPWIRE');
                          
                          let pnlDisplay = '--';
                          if (isShadow) {
                              pnlDisplay = <span className="text-slate-600">VETO</span>;
                          } else if (log.exit_price) {
                              pnlDisplay = <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)}</span>;
                          } else if (log.execution_mode === 'LIVE (EXCHANGE)') {
                              pnlDisplay = <span className={log.pnl >= 0 ? 'text-cyan-400 animate-pulse' : 'text-amber-400 animate-pulse'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)} (U)</span>;
                          } else if (livePrice > 0 && activeTab === 'POSITIONS') {
                              const paperPnl = (log.side === 'BUY' ? livePrice - log.entry_price : log.entry_price - livePrice) * (log.qty || 1);
                              pnlDisplay = <span className={`animate-pulse ${paperPnl >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>${paperPnl.toFixed(4)} (U)</span>;
                          }
                          
                          const timestamp = log.created_at || log.exit_time;
                          const formattedTime = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";

                          return (
                          <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${isShadow ? 'opacity-50' : ''}`}>
                            <td className="px-4 py-3 text-[9px] text-slate-500">
                                <div className="flex flex-col"><span className="text-[10px] font-bold text-slate-400">{formattedTime}</span></div>
                            </td>
                            <td className="px-4 py-3 text-center">
                                <div className="flex flex-col items-center gap-1">
                                    <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-indigo-500/5 text-indigo-300/80 border-indigo-500/10">
                                        {log.strategy_id?.replace('_V1', '')}
                                    </span>
                                    {isShadow && <span className="text-[7px] bg-red-500/20 text-red-300 px-1 rounded uppercase tracking-widest">SHADOW VETO</span>}
                                    {isReversal && !isShadow && <span className="text-[7px] bg-purple-500/20 text-purple-300 px-1 rounded uppercase tracking-widest">REVERSAL</span>}
                                    {isTripwire && !isShadow && <span className="text-[7px] bg-amber-500/20 text-amber-300 px-1 rounded uppercase tracking-widest">TRIPWIRE</span>}
                                </div>
                            </td>
                            <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${isShadow ? 'bg-slate-800 text-slate-500' : (log.side === 'BUY' || log.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}`}>
                                    {log.side} {log.qty > 0 ? `(${log.qty})` : ''}
                                </span>
                            </td>
                            <td className="px-4 py-3 text-slate-300 text-[10px] text-center">${log.entry_price}</td>
                            <td className="px-4 py-3 text-center">
                                {isShadow ? <span className="text-slate-700 italic text-[9px]">Rejected</span> : 
                                 (log.tp_price || log.sl_price ? (
                                    <div className="flex flex-col text-[8px] tracking-tighter uppercase">
                                        <span className="text-emerald-500/60">TP: ${log.tp_price}</span>
                                        <span className="text-red-500/60">SL: ${log.sl_price}</span>
                                    </div>
                                ) : <span className="text-slate-700 italic text-[9px]">Dynamic</span>)}
                            </td>
                            <td className="px-4 py-3">
                                {isShadow ? <span className="text-[9px] text-red-400 font-bold">VETOED</span> :
                                (log.exit_price ? <span className="text-[10px] text-slate-400">${log.exit_price}</span> : 
                                 <><span className="text-indigo-400 animate-pulse font-black text-[9px]">{log.execution_mode.includes('PENDING') ? 'PENDING' : 'ACTIVE'}</span> 
                                 <button onClick={() => log.execution_mode.includes('PENDING') ? handleCancelOrder(log) : handleClosePosition(log)} className="ml-2 bg-red-500/10 text-red-400 border border-red-500/30 px-2 py-0.5 rounded text-[8px] font-black">X</button></>)}
                            </td>
                            <td className="px-4 py-3 text-right font-black text-[10px]">{pnlDisplay}</td>
                          </tr>
                        )})}
                      </tbody>
                    </table>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6 h-[calc(100vh-100px)] overflow-hidden resize-y pb-2">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center justify-between"><span>Active Matrix</span><span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full">{activeAsset}</span></h3>
            <div className="flex flex-col gap-3">
              {currentAssetStrategies.map(strat => {
                const stratLogs = tradeLogs.filter(l => l.strategy_id === strat.strategy && l.execution_mode !== 'SHADOW');
                const totalPnL = stratLogs.reduce((sum, l) => sum + (l.pnl || 0), 0);
                return (
                  <button key={strat.id} onClick={() => handleStrategySelect(strat.strategy)} className="p-4 rounded-2xl border bg-black/20 border-white/5 text-left transition-all hover:bg-white/5 relative overflow-hidden">
                    {/* 🟢 THE FIX: Strategy Power Switch UI */}
                    <div className={`absolute top-0 left-0 w-1 h-full transition-colors ${strat.is_active ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                    
                    <div className="flex justify-between items-center mb-1 pl-2">
                        <span className={`text-xs font-black uppercase transition-colors ${strat.is_active ? 'text-white' : 'text-slate-500'}`}>{strat.strategy.replace('_V1','')}</span>
                        
                        <div 
                            onClick={(e) => { e.stopPropagation(); handleToggleStrategy(strat.strategy, strat.is_active); }}
                            className={`p-1.5 rounded-lg border transition-colors hover:cursor-pointer ${strat.is_active ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 hover:shadow-[0_0_10px_-2px_rgba(16,185,129,0.4)]' : 'bg-slate-800 border-white/5 text-slate-500 hover:bg-slate-700 hover:text-slate-300'}`}
                            title={strat.is_active ? "Pause Strategy" : "Activate Strategy"}
                        >
                            <Power size={12} />
                        </div>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono pl-2">Net PnL: <span className={totalPnL >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>${totalPnL.toFixed(2)}</span></div>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="bg-slate-950 border border-white/10 rounded-[2.5rem] flex flex-col flex-grow overflow-hidden shadow-2xl">
          <div className="px-6 py-4 border-b border-white/5 text-[10px] font-black uppercase text-slate-500 flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-4 flex-grow min-h-[150px]">
              
              {messages.map(m => (
                <div key={m.id} className={`flex flex-col gap-2 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    
                    {m.toolInvocations && m.toolInvocations.map(tool => (
                        <div key={tool.toolCallId} className="text-[9px] text-slate-500 italic bg-black/30 px-3 py-1.5 rounded-lg border border-white/5 flex items-center gap-2">
                            {tool.state === 'result' ? <span className="text-emerald-400 font-bold">✓</span> : <Cpu size={10} className="animate-spin text-indigo-400" />}
                            <span>Nexus executing: <span className="font-bold text-slate-400">{tool.toolName}</span></span>
                        </div>
                    ))}
                    
                    {m.content && (
                        <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${m.role === 'user' ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' : 'bg-slate-900/80 text-cyan-400 border border-white/5'}`}>
                            {m.content}
                        </div>
                    )}

                    {m.role === 'assistant' && !m.content && (!m.toolInvocations || m.toolInvocations.length === 0) && (
                        <div className="max-w-[90%] rounded-2xl px-4 py-3 bg-slate-900/80 text-cyan-400 border border-white/5 flex items-center gap-2">
                            <Cpu size={12} className="animate-spin text-indigo-400" />
                            <span className="animate-pulse">Nexus is thinking...</span>
                        </div>
                    )}
                </div>
              ))}
              
              {sdkError && (
                <div className="flex justify-start"><div className="max-w-[90%] rounded-2xl px-4 py-3 bg-red-500/10 text-red-400 border border-red-500/20">[SYSTEM FAULT]: {sdkError.message}</div></div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleManualSubmit} className="p-4 border-t border-white/5 bg-slate-900/40 flex gap-3">
                <input 
                  className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white focus:outline-none focus:border-indigo-500/50" 
                  value={localInput} 
                  onChange={(e) => setLocalInput(e.target.value)} 
                  placeholder="Command Nexus..." 
              />
              <button type="submit" disabled={!localInput?.trim() || isLoading} className={`border rounded-xl px-4 py-3 transition-all flex items-center justify-center min-w-[50px] ${isLoading ? 'bg-indigo-500/40 border-indigo-500/50 text-indigo-200 animate-pulse' : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/30'}`}>
                  {isLoading ? <span className="text-[10px] font-black tracking-widest">...</span> : <Send size={16} />}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}