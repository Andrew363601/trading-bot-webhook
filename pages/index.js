// HARD PUSH:

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { useChat } from '@ai-sdk/react'; 
import Link from 'next/link'; 
import { createChart, CrosshairMode, CandlestickSeries, createSeriesMarkers, HistogramSeries } from 'lightweight-charts';
import { 
  Database, BarChart3, Cpu, Terminal as TerminalIcon, 
  Send, Activity, PieChart, Shield, Zap, TrendingUp, TrendingDown,
  Target, AlertTriangle, ArrowRight, RefreshCw, Layers, BrainCircuit,
  Settings, LogOut, Clock, Crosshair, ChevronRight, Menu, X, PlusCircle,
  Search, AlertOctagon, Eye, Minimize2, Maximize2, Power, ChevronDown, Sun, Moon
} from 'lucide-react';
import AuthGuard from '../components/AuthGuard';
import MarketScanner from '../components/MarketScanner';

export default function Dashboard() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}

function DashboardContent() {
  const supabase = useSupabaseClient();
  const session = useSession();
  const [theme, setTheme] = useState('dark'); // Default to dark mode

  // Theme persistence
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    } else {
      document.documentElement.classList.add('dark'); // Default to dark if no preference
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'dark' ? 'light' : 'dark'));
  };

  // Helper to normalize asset symbols for consistent comparison
  const normalizeAssetSymbol = useCallback((symbol) => {
    if (!symbol) return '';
    return symbol.replace(/(-PERP-INTX|-CDE|-PERP|-USD|-USDT)/g, '').toUpperCase();
  }, []);

  const [activeAsset, setActiveAsset] = useState('BTC-PERP-INTX');
  const [activeTab, setActiveTab] = useState('ANALYTICS');
  
  const [assetsList, setAssetsList] = useState([
    'BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX', 'DOGE-PERP-INTX',
    'LINK-PERP-INTX', 'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX'
  ]);
  
  const [livePrice, setLivePrice] = useState(0); 
  const [tradeLogs, setTradeLogs] = useState([]);
  const [activeStrategies, setActiveStrategies] = useState([]);
  const [scanStream, setScanStream] = useState([]); 
  const [portfolio, setPortfolio] = useState({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 } });
  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState(null); // Cache tenant_id for data filtering
  
  // Header metrics state for reactive updates
  const [latestScan, setLatestScan] = useState(null);
  const [bids, setBids] = useState(0);
  const [asks, setAsks] = useState(0);
  const [cvd, setCvd] = useState(0);
  const [totalLiquidity, setTotalLiquidity] = useState(0);
  const [targetPercent, setTargetPercent] = useState(50);
  
  const [livePositions, setLivePositions] = useState([]);
  const [liveOrders, setLiveOrders] = useState([]);
  const [isChartMaximized, setIsChartMaximized] = useState(false);
  const [isDefconActive, setIsDefconActive] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const seriesMarkersRef = useRef(null); 
  const priceLinesRef = useRef([]);
  const [chartTimeframe, setChartTimeframe] = useState('1m');

  const [localInput, setLocalInput] = useState('');

  // Trade log filter state
  const [logStrategyFilter, setLogStrategyFilter] = useState('ALL');
  const [logStatusFilter, setLogStatusFilter] = useState('ALL');
  const [sessionLogAgentFilter, setSessionLogAgentFilter] = useState('ALL'); // New state for session log filter

  // Active matrix navigation state
  const [currentStrategyIndex, setCurrentStrategyIndex] = useState(0);
  const [strategyMetadata, setStrategyMetadata] = useState([]);
  const [sessionLogs, setSessionLogs] = useState([]);

  // Strategy management state for edit modal
  const [editingStrategy, setEditingStrategy] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingParameters, setEditingParameters] = useState({});
  const [editingExecutionMode, setEditingExecutionMode] = useState('PAPER');

  const normalizeParametersForEditor = useCallback((params) => {
    if (!params) return {};

    const normalized = {};
    for (const key in params) {
      const value = params[key];
      if (typeof value === 'object' && value !== null && 'default' in value && 'type' in value) {
        normalized[key] = value;
      } else {
        normalized[key] = {
          default: value,
          type: typeof value === 'number' ? 'number' : 'text',
          label: key.replace(/_/g, ' ').toUpperCase(),
          ...(key.includes('leverage') && { min: 1, max: 10 }),
          ...(key.includes('quantity') && { min: 0.001, max: 100 }),
          ...(key.includes('stop_loss_pct') && { min: 0.1, max: 20 }),
          ...(key.includes('take_profit_pct') && { min: 0.1, max: 50 }),
        };
      }
    }
    return normalized;
  }, []);

  const flattenParametersForSave = useCallback((params) => {
    if (!params) return {};

    const flattened = {};
    for (const key in params) {
      const value = params[key];
      if (typeof value === 'object' && value !== null && ('default' in value || 'value' in value)) {
        flattened[key] = value.value !== undefined ? value.value : value.default;
      } else {
        flattened[key] = value;
      }
    }
    return flattened;
  }, []);

  const chatHeaders = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token]);

  const { messages, append, error: sdkError, isLoading, setMessages } = useChat({
    api: '/api/chat',
    id: 'nexus-terminal-v1',
    headers: {
      Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
    },
    onResponse: (response) => {
        console.log("[NEXUS CHAT] Response received:", response.status);
    },
    onFinish: (message) => {
        console.log("[NEXUS CHAT] Message finished:", message.content.substring(0, 20) + "...");
    },
    onError: (err) => {
      console.error("[NEXUS AGENT FATAL]:", err);
    }
  });

  // Persist messages to session storage to avoid losing them on reload
  useEffect(() => {
    if (messages.length > 0) {
      sessionStorage.setItem('nexus_chat_history', JSON.stringify(messages));
    }
  }, [messages]);

  useEffect(() => {
    const saved = sessionStorage.getItem('nexus_chat_history');
    if (saved && messages.length === 0) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      } catch (e) {
        console.error("[NEXUS DEBUG] Failed to load chat history:", e);
      }
    }
  }, [setMessages, messages.length]);

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

  // Load tenant_id on mount for data filtering
  useEffect(() => {
    const loadTenantId = async () => {
      if (!session?.user?.id) return;
      try {
        const { data: users, error } = await supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('auth_user_id', session.user.id)
          .single();

        if (error) {
          console.error('Failed to fetch tenant_id:', error);
          return;
        }
        if (users?.tenant_id) {
          setTenantId(users.tenant_id);
          console.log('[DEBUG] Loaded tenant_id for data filtering');
        }
      } catch (err) {
        console.error('Failed to load tenant_id:', err);
      }
    };
    loadTenantId();
  }, [session?.user?.id, supabase]);

  const fetchData = useCallback(async () => {
    try {
      // Build queries with tenant_id filtering
      let logsQuery = supabase.from('trade_logs').select('*').order('created_at', { ascending: false });
      let configsQuery = supabase.from('strategy_config').select('*');
      let scansQuery = supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(25);
      let sessionLogsQuery = supabase.from('agent_session_logs').select('*').order('timestamp', { ascending: false }).limit(200);

      // Add tenant_id filtering if available
      if (tenantId) {
        logsQuery = logsQuery.eq('tenant_id', tenantId);
        configsQuery = configsQuery.eq('tenant_id', tenantId);
        scansQuery = scansQuery.eq('tenant_id', tenantId);
        sessionLogsQuery = sessionLogsQuery.eq('tenant_id', tenantId);
      }

      const [logsRes, configsRes, scansRes, sessionLogsRes] = await Promise.all([
          logsQuery,
          configsQuery,
          scansQuery,
          sessionLogsQuery
      ]);

      setTradeLogs(logsRes.data || []);
      setActiveStrategies(configsRes.data || []);
      setScanStream(scansRes.data || []);
      setSessionLogs(sessionLogsRes.data || []);
      
      setLoading(false); 

      fetch(`/api/portfolio?asset=${activeAsset}`, {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setPortfolio(data);
                  if (data.price > 0) setLivePrice(data.price);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Portfolio API delayed:", e.message));

      fetch('/api/coinbase-sync', {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setLivePositions(data.positions || []);
                  setLiveOrders(data.orders || []);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Exchange API delayed:", e.message));

      fetch(`/api/get-strategies-for-asset?asset=${activeAsset}`, {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
      .then(res => res.json())
      .then(data => {
          if (data && data.strategies) {
              setStrategyMetadata(data.strategies);
          }
      })
      .catch(e => console.warn("[NEXUS SYNC] Strategy Metadata API delayed:", e.message));

    } catch (e) { 
      console.error("[NEXUS FATAL] DB Fetch Error:", e); 
      setLoading(false); 
    }
  }, [activeAsset, supabase, tenantId, session?.access_token]);

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
  };

  const handleToggleStrategy = async (configId, currentState) => {
      try {
          await supabase.from('strategy_config').update({ is_active: !currentState }).eq('id', configId);
          fetchData(); 
      } catch (err) {
          console.error("Failed to toggle strategy:", err);
      }
  };


  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); 
  }, [messages]);

  const handleClosePosition = async (trade) => {
    const confirmClose = window.confirm(`Liquidate ${trade.side} position on ${trade.strategy_id || 'Exchange'}?`);
    if (!confirmClose) return;
    const closingSide = (trade.side === 'BUY' || trade.side === 'LONG') ? 'SELL' : 'BUY';
    try {
      const closeRes = await fetch('/api/close-position', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          side: closingSide,
          qty: trade.qty,
          price: livePrice || 0
        })
      });
      if (closeRes.ok) {
        fetchData();
      } else {
        const err = await closeRes.json();
        alert(`Error closing position: ${err.error}`);
      }
    } catch (e) {
      alert(`Error closing position: ${e.message}`);
    }
  };

  const handleCancelOrder = async (order) => {
      const confirmCancel = window.confirm(`Cancel pending ${order.side} limit order for ${order.symbol}?`);
      if (!confirmCancel) return;
      
      try {
          await fetch('/api/cancel-order', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session?.access_token}`
              },
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

  const openStrategyEditor = (strat) => {
    setEditingStrategy(strat);
    setEditingParameters(normalizeParametersForEditor(strat.parameters));
    setEditingExecutionMode(strat.execution_mode || 'PAPER');
    setEditModalOpen(true);
  };

  const saveStrategyChanges = async () => {
    if (!editingStrategy) return;
    try {
      const { error } = await supabase
        .from('strategy_config')
        .update({
          parameters: flattenParametersForSave(editingParameters),
          execution_mode: editingExecutionMode,
          updated_at: new Date().toISOString()
        })
        .eq('id', editingStrategy.id);

      if (error) {
        console.error('Failed to update strategy:', error);
        alert(`❌ Failed to update strategy: ${error.message}`);
      } else {
        console.log('[DEBUG] Strategy updated successfully');
        alert('✅ Strategy updated successfully');
        setEditModalOpen(false);
        fetchData(); // Refresh data
      }
    } catch (err) {
      console.error('Failed to save strategy changes:', err);
      alert('❌ Failed to save strategy changes');
    }
  };

  // FIX: Filter strategies by normalized asset symbol for consistency
  const currentAssetStrategies = useMemo(() => {
    const normalizedActiveAsset = normalizeAssetSymbol(activeAsset);
    return activeStrategies.filter(s => normalizeAssetSymbol(s.asset) === normalizedActiveAsset);
  }, [activeStrategies, activeAsset, normalizeAssetSymbol]);

  const paperPositions = useMemo(() => tradeLogs.filter(log => 
    !log.exit_price && 
    log.execution_mode === 'PAPER' &&
    normalizeAssetSymbol(log.symbol) === normalizeAssetSymbol(activeAsset)
  ), [tradeLogs, activeAsset, normalizeAssetSymbol]);
  
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
  
  const tradeHistory = useMemo(() => tradeLogs.filter(log => 
    log.exit_price &&
    normalizeAssetSymbol(log.symbol) === normalizeAssetSymbol(activeAsset)
  ), [tradeLogs, activeAsset, normalizeAssetSymbol]);
  
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
        visible: true, 
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
        if(!seriesRef.current || !volumeSeriesRef.current || !chartRef.current) return;

        const tfMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
        const granularity = tfMap[chartTimeframe] || 60;

        try {
            const res = await fetch(`/api/chart-data?asset=${activeAsset}&granularity=${granularity}&limit=1500&deepCache=true`);
            if(!res.ok) throw new Error("Chart proxy failed");
            
            const data = await res.json();
            if(!isMounted) return;

            if (!Array.isArray(data) || data.length === 0) {
                seriesRef.current.setData([]);
                volumeSeriesRef.current.setData([]);
                seriesMarkersRef.current.setMarkers([]); // Clear markers if no data
                return;
            }

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

                // Update markers for the new asset and data
                const relevantMarkers = tradeLogs
                    .filter(trade => normalizeAssetSymbol(trade.symbol) === normalizeAssetSymbol(activeAsset))
                    .map(trade => {
                        const tradeTime = new Date(trade.created_at).getTime() / 1000;
                        const exitTime = trade.exit_time ? new Date(trade.exit_time).getTime() / 1000 : null;

                        const markers = [];

                        // Entry marker
                        if (trade.entry_price) {
                            markers.push({
                                time: tradeTime,
                                position: trade.side === 'BUY' ? 'belowBar' : 'aboveBar',
                                color: trade.side === 'BUY' ? '#10b981' : '#ef4444',
                                shape: trade.side === 'BUY' ? 'arrowUp' : 'arrowDown',
                                text: `${trade.side} ${trade.qty} @ ${trade.entry_price}`
                            });
                        }

                        // Exit marker
                        if (exitTime && trade.exit_price) {
                            markers.push({
                                time: exitTime,
                                position: trade.side === 'BUY' ? 'aboveBar' : 'belowBar',
                                color: trade.side === 'BUY' ? '#ef4444' : '#10b981',
                                shape: trade.side === 'BUY' ? 'arrowDown' : 'arrowUp',
                                text: `Closed @ ${trade.exit_price} PnL: ${trade.pnl}`
                            });
                        }
                        return markers;
                    })
                    .flat(); // Flatten array of arrays into a single array

                seriesMarkersRef.current.setMarkers(relevantMarkers);
            }
        } catch(e) { console.error("Chart Fetch Error:", e); }
    };

    loadChartData(false);
    intervalId = setInterval(() => loadChartData(true), 3000);

    return () => {
        isMounted = false;
        clearInterval(intervalId);
    };
  }, [activeAsset, chartTimeframe, tradeLogs, normalizeAssetSymbol]);

  useEffect(() => {
      if(!seriesRef.current || !seriesMarkersRef.current) return;
      // Clear markers when activeAsset changes to prevent duplicates
      seriesMarkersRef.current.setMarkers([]);

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

          const currentStrat = activeStrategies.find(s => s.asset === activeAsset);
          if (currentStrat?.trap_price) {
              const tPrice = parseFloat(currentStrat.trap_price);
              const color = currentStrat.trap_side === 'BUY' ? '#10b981' : '#ef4444';
              const trapLine = seriesRef.current.createPriceLine({ price: tPrice, color: color, lineWidth: 2, lineStyle: 2, title: `👻 ${currentStrat.trap_side} TRAP` });
              priceLinesRef.current.push(trapLine);
          }

          const assetScans = scanStream.filter(s => s.asset === activeAsset);
          const latestAssetScan = assetScans.length > 0 ? assetScans[0] : null;
          if (latestAssetScan?.telemetry) {
              const t = latestAssetScan.telemetry;
              
              if (t.macro_poc && t.macro_poc !== "None") {
                  const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.macro_poc), color: '#f59e0b', lineWidth: 2, lineStyle: 0, title: 'MACRO POC' });
                  priceLinesRef.current.push(pl);
              }
              if (t.upper_macro_node && t.upper_macro_node !== "None") {
                  const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.upper_macro_node), color: '#94a3b8', lineWidth: 1, lineStyle: 1, title: 'UPPER NODE' });
                  priceLinesRef.current.push(pl);
              }
              if (t.lower_macro_node && t.lower_macro_node !== "None") {
                  const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.lower_macro_node), color: '#94a3b8', lineWidth: 1, lineStyle: 1, title: 'LOWER NODE' });
                  priceLinesRef.current.push(pl);
              }
          }

      } catch (err) {
          console.error("Marker Drawing Error:", err);
      }
  }, [tradeLogs, openPositions, activeAsset, chartTimeframe, activeStrategies, scanStream]);

  // Update header metrics when activeAsset or scanStream changes
  useEffect(() => {
    const activeAssetScans = scanStream.filter(s => normalizeAssetSymbol(s.asset) === normalizeAssetSymbol(activeAsset));
    const scan = activeAssetScans.length > 0 ? activeAssetScans[0] : null;
    
    setLatestScan(scan);
    const b = parseFloat(scan?.telemetry?.bids || 0);
    const a = parseFloat(scan?.telemetry?.asks || 0);
    const c = parseFloat(scan?.telemetry?.cvd || 0);
    
    setBids(b);
    setAsks(a);
    setCvd(c);
    
    const totalLiq = b + a;
    setTotalLiquidity(totalLiq);
    const targetPct = totalLiq > 0 ? (b / totalLiq) * 100 : 50;
    setTargetPercent(targetPct);
    
    console.log(`[DEBUG] Header metrics updated for ${activeAsset}: bids=${b}, asks=${a}, cvd=${c}`);
  }, [activeAsset, scanStream, normalizeAssetSymbol]);

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


  // Apply filters to logs
  let displayLogs = [];
  let baseDisplayLogs = [];
  if (activeTab === 'POSITIONS') baseDisplayLogs = openPositions;
  else if (activeTab === 'TRADE_HISTORY') baseDisplayLogs = tradeHistory;
  else if (activeTab === 'OPEN_ORDERS') baseDisplayLogs = openOrders;

  // Filter by strategy
  let filteredByStrategy = baseDisplayLogs;
  if (logStrategyFilter !== 'ALL') {
    filteredByStrategy = baseDisplayLogs.filter(log => log.strategy_id === logStrategyFilter || log.strategy_id?.replace('_V1', '') === logStrategyFilter);
  }

  // Filter by status (for trade history: WINNER/LOSER/SHADOW, for positions: ACTIVE, for orders: PENDING)
  let filteredByStatus = filteredByStrategy;
  if (logStatusFilter !== 'ALL') {
    if (activeTab === 'TRADE_HISTORY') {
      if (logStatusFilter === 'WINNER') filteredByStatus = filteredByStrategy.filter(log => log.pnl > 0);
      else if (logStatusFilter === 'LOSER') filteredByStatus = filteredByStrategy.filter(log => log.pnl < 0);
      else if (logStatusFilter === 'SHADOW') filteredByStatus = filteredByStrategy.filter(log => log.execution_mode === 'SHADOW');
    } else if (activeTab === 'POSITIONS') {
      if (logStatusFilter === 'ACTIVE') filteredByStatus = filteredByStrategy.filter(log => !log.exit_price);
    } else if (activeTab === 'OPEN_ORDERS') {
      if (logStatusFilter === 'PENDING') filteredByStatus = filteredByStrategy.filter(log => log.execution_mode === 'PENDING_LIMIT');
    }
  }

  displayLogs = filteredByStatus;


  return (
    <div className="min-h-screen dark:bg-[#020617] dark:text-slate-200 bg-white text-slate-900 px-2 sm:px-4 py-4 font-sans flex flex-col gap-4 relative">
      
      {isDefconActive && (
          <div className="bg-red-500/20 border-b border-red-500/50 text-red-200 px-6 py-3 flex items-center justify-center gap-3 w-full animate-pulse z-50">
              <AlertTriangle size={18} className="text-red-400" />
              <span className="text-[11px] font-black uppercase tracking-widest">
                  DEFCON 3: OVERNIGHT MARGIN SWEEP APPROACHING. VERIFY CAPITAL OR FLATTEN OPEN DERIVATIVE POSITIONS.
              </span>
          </div>
      )}

      {loading && (
         <div className="absolute inset-0 z-50 dark:bg-[#020617]/90 bg-white/90 backdrop-blur-sm flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">
             Establishing Nexus...
         </div>
      )}

      <header className="max-w-[1800px] w-full mx-auto flex justify-between items-center border-b dark:border-white/5 border-slate-300/5 pb-4 px-4 sm:px-0">
        <div className="flex items-center gap-2 sm:gap-4">
            <h1 className="text-lg sm:text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus</h1>
            <div className="hidden sm:block h-6 w-[1px] bg-white/10 mx-2" />
            <div className="hidden sm:flex items-center gap-2">
                <Link href="/audit" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Shield className="w-3 h-3" /> Audit
                </Link>
                <Link href="/settings" className="text-[10px] font-black uppercase tracking-widest bg-slate-500/10 hover:bg-slate-500/20 text-slate-300 border border-white/5 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Settings className="w-3 h-3" /> API Keys
                </Link>
                <button 
                    onClick={toggleTheme} 
                    className="text-[10px] font-black uppercase tracking-widest bg-slate-500/10 hover:bg-slate-500/20 text-slate-300 border border-white/5 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2"
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                    {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                    {theme === 'dark' ? 'Light' : 'Dark'}
                </button>
                <Link href="/performance" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Activity className="w-3 h-3" /> Performance
                </Link>
            </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-8">
            <div className="hidden md:flex items-center gap-6">
                <div className="flex flex-col items-end">
                    <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-1"><Shield size={8} className="text-emerald-400"/> Live Equity</span>
                    <span className="text-sm font-black font-mono text-white">${portfolio.live?.balance?.toFixed(2) || '0.00'}</span>
                </div>
                <div className="flex flex-col items-end">
                    <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-1"><Cpu size={8} className="text-indigo-400"/> Nexus Paper</span>
                    <span className="text-sm font-black font-mono text-slate-300">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</span>
                </div>
            </div>
            <div className="hidden sm:flex text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em] items-center gap-2 bg-white/5 px-3 py-2 rounded-lg border border-white/5"><Database size={10} /> Sync</div>
            <button onClick={() => setShowMobileMenu(!showMobileMenu)} className="sm:hidden p-2 rounded-lg hover:bg-white/5 transition-colors">
                {showMobileMenu ? <X size={18} /> : <Menu size={18} />}
            </button>
        </div>
      </header>

      {showMobileMenu && (
        <div className="sm:hidden bg-slate-900/50 border-b border-white/5 p-4 space-y-3 z-40 flex flex-col">
          <Link href="/audit" target="_blank" onClick={() => setShowMobileMenu(false)} className="text-[9px] font-black uppercase tracking-widest bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Shield className="w-3 h-3" /> Audit
          </Link>
          <Link href="/settings" onClick={() => setShowMobileMenu(false)} className="text-[9px] font-black uppercase tracking-widest bg-slate-500/10 text-slate-300 border border-white/5 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Settings className="w-3 h-3" /> API Keys
          </Link>
          <button 
              onClick={() => { toggleTheme(); setShowMobileMenu(false); }} 
              className="text-[9px] font-black uppercase tracking-widest bg-slate-500/10 text-slate-300 border border-white/5 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full"
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <Link href="/performance" target="_blank" onClick={() => setShowMobileMenu(false)} className="text-[9px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Activity className="w-3 h-3" /> Performance
          </Link>
          <div className="border-t border-white/5 pt-3 mt-3">
            <div className="flex flex-col gap-2">
              <div className="flex justify-between">
                <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Live:</span>
                <span className="text-[9px] font-black font-mono text-emerald-400">${portfolio.live?.balance?.toFixed(2) || '0.00'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Paper:</span>
                <span className="text-[9px] font-black font-mono text-indigo-400">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🔴 NEW COINBASE STYLE TICKER BAR */}
      <div className="max-w-[1800px] w-full mx-auto bg-slate-900/40 border border-white/5 rounded-2xl p-2 px-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 sm:gap-0 backdrop-blur-md relative z-40">
        <div className="w-full sm:w-auto flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8">
          <div className="relative w-full sm:w-auto">
            <button 
              onClick={() => setShowScanner(!showScanner)}
              className="w-full sm:w-auto flex items-center gap-2 sm:gap-3 group px-3 sm:px-4 py-2 rounded-xl hover:bg-white/5 transition-all"
            >
              <div className="flex flex-col items-start w-full">
                <span className="text-[7px] sm:text-[8px] font-black text-indigo-500 uppercase tracking-widest">Market</span>
                <div className="flex items-center gap-2 w-full">
                  <span className="text-base sm:text-lg font-black text-white italic tracking-tighter uppercase truncate">{activeAsset}</span>
                  <ChevronDown size={14} className={`text-slate-500 transition-transform flex-shrink-0 ${showScanner ? 'rotate-180' : ''}`} />
                </div>
              </div>
            </button>

            {showScanner && (
              <div className="absolute top-full left-0 mt-2 w-full sm:w-[calc(100vw-32px)] md:w-80 bg-[#020617] border border-white/10 rounded-3xl shadow-2xl z-50 p-2 overflow-hidden animate-in fade-in slide-in-from-top-2 max-h-[calc(100vh-150px)]">
                <div className="flex items-center justify-between p-3 border-b border-white/5">
                   <span className="text-[9px] sm:text-[10px] font-black uppercase text-indigo-400 tracking-widest">Select Asset</span>
                   <button onClick={() => setShowScanner(false)} className="text-slate-500 hover:text-white"><X size={14}/></button>
                </div>
                <div className="p-2">
                  <MarketScanner 
                    onSelectAsset={(assetId) => {
                      setActiveAsset(assetId);
                      handleAddAsset(assetId);
                      setShowScanner(false);
                    }}
                    currentAsset={activeAsset}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="flex-1 sm:flex-none flex flex-col">
            <span className="text-[7px] sm:text-[8px] font-black text-emerald-500/60 uppercase tracking-widest">Market Feed</span>
            <div className="flex items-baseline gap-1 sm:gap-2">
              <span className={`text-lg sm:text-xl font-mono font-black tracking-tighter ${livePrice > 0 ? 'text-emerald-400' : 'text-slate-700'}`}>
                ${livePrice > 0 ? livePrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '---'}
              </span>
              <span className="text-[8px] sm:text-[9px] font-bold text-slate-500 uppercase">USD</span>
            </div>
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">CVD</span>
                <span className={`text-xs sm:text-sm font-mono font-bold ${cvd !== 0 ? (cvd > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}>
                    {cvd > 0 ? '+' : ''}{cvd.toFixed(0)}
                </span>
             </div>
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Score</span>
                <span className="text-xs sm:text-sm font-mono font-bold text-indigo-400">{latestScan?.telemetry?.oracle_score || '--'}</span>
             </div>
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Regime</span>
                {latestScan?.telemetry?.macro_regime_oracle && (
                    <span className={`text-[8px] sm:text-[10px] font-black uppercase tracking-widest ${latestScan.telemetry.macro_regime_oracle === 'TREND' ? 'text-emerald-400' : (latestScan.telemetry.macro_regime_oracle === 'CHOP' ? 'text-amber-400' : 'text-slate-500')}`}>
                        {latestScan.telemetry.macro_regime_oracle}
                    </span>
                )}
             </div>
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="w-full sm:w-48 flex flex-col">
              <div className="flex justify-between items-center mb-1">
                  <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Liquidity</span>
                  <div className="flex gap-1 sm:gap-2 text-[7px] sm:text-[8px] font-mono">
                      <span className="text-emerald-400">B:{bids.toFixed(0)}</span>
                      <span className="text-red-400">A:{asks.toFixed(0)}</span>
                  </div>
              </div>
              {totalLiquidity > 0 ? (
                  <div className="w-full h-1.5 rounded-full overflow-hidden flex bg-slate-800">
                      <div style={{ width: `${liveBidPercent}%` }} className="h-full bg-emerald-500/80 transition-all duration-500 ease-linear" />
                      <div style={{ width: `${100 - liveBidPercent}%` }} className="h-full bg-red-500/80 transition-all duration-500 ease-linear" />
                  </div>
              ) : <div className="h-1.5 bg-slate-800 rounded-full animate-pulse w-full" />}
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
             <div className={`px-3 py-1.5 rounded-lg border flex items-center gap-2 transition-all ${isResonant ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 animate-pulse shadow-[0_0_15px_-3px_rgba(16,185,129,0.4)]' : (isVeto ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-slate-800/50 text-slate-600 border-white/5')}`}>
                <div className={`h-1.5 w-1.5 rounded-full ${isResonant ? 'bg-emerald-400' : (isVeto ? 'bg-red-400' : 'bg-slate-600')}`} />
                <span className="text-[9px] font-black uppercase tracking-widest">{latestScan?.status || 'IDLE'}</span>
             </div>
        </div>
      </div>

      <main className="max-w-[1800px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 md:gap-6 grow overflow-hidden px-4 sm:px-0">
        
        <div className="lg:col-span-9 flex flex-col gap-3 sm:gap-4 md:gap-6 min-h-0 h-[calc(100vh-280px)] sm:h-[calc(100vh-240px)] md:h-[calc(100vh-200px)] lg:h-[calc(100vh-180px)]">
          
          <div className={isChartMaximized ? "fixed inset-4 z-[100] bg-[#020617] border border-indigo-500/50 rounded-3xl p-6 shadow-2xl flex flex-col transition-all" : "bg-slate-900/50 border border-white/10 rounded-[2.5rem] overflow-hidden min-h-[300px] flex-grow relative shadow-2xl flex flex-col transition-all"}>
            
            <button onClick={() => setIsChartMaximized(!isChartMaximized)} className="absolute top-4 right-4 z-50 bg-black/40 hover:bg-indigo-500/20 text-slate-400 hover:text-indigo-300 border border-white/10 hover:border-indigo-500/50 p-2 rounded-lg transition-colors backdrop-blur-md">
                {isChartMaximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}
            </button>

            <div className="absolute top-6 right-16 z-20 flex flex-col gap-2 max-w-[280px] pointer-events-none">
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

            <div className="px-6 py-3 flex items-center justify-between border-b border-white/5 bg-black/20 backdrop-blur-md rounded-t-[2rem]">
              <div className="flex items-center gap-4">
                <div className="flex bg-black/40 p-1 rounded-xl border border-white/5 gap-1">
                  {['1m', '5m', '15m', '1h', '4h'].map(tf => (
                    <button 
                      key={tf} 
                      onClick={() => setChartTimeframe(tf)}
                      className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase transition-all ${chartTimeframe === tf ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-grow w-full relative mt-0 mb-4 px-2 min-h-[300px]">
                <div ref={chartContainerRef} className="absolute inset-0" />
            </div>
          </div>

          <div className="flex flex-col h-[35%] overflow-hidden border border-white/5 rounded-[2rem] bg-slate-900/30 pb-2">
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

            {/* Log Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b border-white/5 bg-slate-950/40 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Strategy:</label>
                <select 
                  value={logStrategyFilter}
                  onChange={(e) => setLogStrategyFilter(e.target.value)}
                  className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1 text-[9px] font-bold text-slate-300 outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="ALL">All</option>
                  {[...new Set(baseDisplayLogs.map(log => log.strategy_id).filter(Boolean))].map(strat => (
                    <option key={strat} value={strat}>{strat?.replace('_V1', '')}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Status:</label>
                <select 
                  value={logStatusFilter}
                  onChange={(e) => setLogStatusFilter(e.target.value)}
                  className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1 text-[9px] font-bold text-slate-300 outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="ALL">All</option>
                  {activeTab === 'TRADE_HISTORY' && (
                    <>
                      <option value="WINNER">Winner (P&L +)</option>
                      <option value="LOSER">Loser (P&L -)</option>
                      <option value="SHADOW">Shadow (Veto)</option>
                    </>
                  )}
                  {activeTab === 'POSITIONS' && (
                    <option value="ACTIVE">Active</option>
                  )}
                  {activeTab === 'OPEN_ORDERS' && (
                    <option value="PENDING">Pending</option>
                  )}
                </select>
              </div>
            </div>

            <div className="overflow-y-auto overflow-x-auto custom-scrollbar flex-grow min-h-[300px] sm:min-h-[500px] max-h-[calc(100vh-400px)]">
              {displayLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12">
                  <Layers size={24} className="mb-2 opacity-50" />
                  <p className="text-[11px] font-bold uppercase tracking-widest">No data available</p>
                </div>
              ) : (
                <table className="w-full min-w-max text-left">
                  <thead className="bg-slate-950/40 text-[9px] font-black text-slate-600 uppercase tracking-widest sticky top-0 backdrop-blur-md z-10">
                    <tr>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[70px]">Date</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[100px] text-center">Context</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[60px] text-center">Vector</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[80px] text-center">Entry</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[80px] text-center">Targets</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[70px]">Status</th>
                      <th className="px-2 py-2 whitespace-nowrap min-w-[70px] text-right">PnL</th>
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
                        <td className="responsive-table-cell date text-[9px] text-slate-500">
                            <div className="flex flex-col"><span className="text-[10px] font-bold text-slate-400">{formattedTime}</span></div>
                        </td>
                        <td className="responsive-table-cell context text-center">
                            <div className="flex flex-col items-center gap-1">
                                <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-indigo-500/5 text-indigo-300/80 border-indigo-500/10">
                                    {log.strategy_id?.replace('_V1', '')}
                                </span>
                                {isShadow && <span className="text-[7px] bg-red-500/20 text-red-300 px-1 rounded uppercase tracking-widest">SHADOW VETO</span>}
                                {isReversal && !isShadow && <span className="text-[7px] bg-purple-500/20 text-purple-300 px-1 rounded uppercase tracking-widest">REVERSAL</span>}
                                {isTripwire && !isShadow && <span className="text-[7px] bg-amber-500/20 text-amber-300 px-1 rounded uppercase tracking-widest">TRIPWIRE</span>}
                            </div>
                        </td>
                        <td className="responsive-table-cell vector text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${isShadow ? 'bg-slate-800 text-slate-500' : (log.side === 'BUY' || log.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}`}>
                                {log.side} {log.qty > 0 ? `(${log.qty})` : ''}
                            </span>
                        </td>
                        <td className="responsive-table-cell entry text-[10px] text-slate-300 text-center">
                            {log.entry_price ? `$${log.entry_price.toFixed(2)}` : '---'}
                        </td>
                        <td className="responsive-table-cell targets text-center">
                            {isShadow ? <span className="text-slate-700 italic text-[9px]">Rejected</span> : 
                             (log.tp_price || log.sl_price ? (
                                <div className="flex flex-col text-[8px] tracking-tighter uppercase">
                                    <span className="text-emerald-500/60">TP: ${log.tp_price ? log.tp_price.toFixed(2) : '---'}</span>
                                    <span className="text-red-500/60">SL: ${log.sl_price ? log.sl_price.toFixed(2) : '---'}</span>
                                </div>
                            ) : <span className="text-slate-700 italic text-[9px]">Dynamic</span>)}
                        </td>
                        <td className="responsive-table-cell status text-center">
                            {isShadow ? <span className="text-[9px] text-red-400 font-bold">VETOED</span> :
                            (log.exit_price ? <span className="text-[10px] text-slate-400">${log.exit_price.toFixed(2)}</span> : 
                             <><span className="text-indigo-400 animate-pulse font-black text-[9px]">{log.execution_mode.includes('PENDING') ? 'PENDING' : 'ACTIVE'}</span> 
                             <button onClick={() => log.execution_mode.includes('PENDING') ? handleCancelOrder(log) : handleClosePosition(log)} className="ml-2 bg-red-500/10 text-red-400 border border-red-500/30 px-2 py-0.5 rounded text-[8px] font-black">X</button></>)}
                        </td>
                        <td className="responsive-table-cell pnl text-right font-black text-[10px]">{pnlDisplay}</td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

                <div className="lg:col-span-3 flex flex-col gap-3 sm:gap-4 md:gap-6 h-auto lg:h-[calc(100vh-180px)] overflow-hidden lg:resize-y pb-2">
          <div className="bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase text-slate-500 mb-4 flex items-center justify-between">
              <span>Active Matrix</span>
              <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-mono uppercase">
                {normalizeAssetSymbol(activeAsset)}
              </span>
            </h3>
            
            {currentAssetStrategies.length === 0 ? (
                <div className="text-center py-8 text-slate-600 text-[10px] uppercase font-bold border border-dashed border-white/5 rounded-2xl">No Strategies Active</div>
            ) : (() => {
                const strat = currentAssetStrategies[currentStrategyIndex % currentAssetStrategies.length];
                if (!strat) return null;
                
                const stratLogs = tradeLogs.filter(l => (l.strategy_id === strat.strategy || l.strategy_id === strat.id) && l.execution_mode !== 'SHADOW' && l.exit_price);
                const totalPnL = stratLogs.reduce((sum, l) => sum + (l.pnl || 0), 0);
                
                // ROI Calculation: (PnL / (Entry Price * Qty)) * 100
                const avgRoi = stratLogs.length > 0 
                  ? (stratLogs.reduce((sum, l) => {
                      const cost = l.entry_price * l.qty;
                      return sum + (cost > 0 ? (l.pnl / cost) * 100 : 0);
                    }, 0) / stratLogs.length).toFixed(2)
                  : "0.00";

                // Description from metadata (fallback if not loaded yet)
                const meta = strategyMetadata.find(m => m.id === strat.strategy);
                const description = meta?.description || "Strategic execution layer focused on volatility and volume nodes.";

                return (
                  <div className="relative group">
                    <div className="p-4 rounded-3xl border bg-black/40 border-white/10 text-left transition-all relative overflow-hidden flex flex-col gap-4">
                      <div className={`absolute top-0 left-0 w-full h-1 transition-colors ${strat.is_active ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`} />
                      
                      <div className="flex justify-between items-start">
                          <div className="flex flex-col">
                            <span className={`text-[13px] font-black uppercase tracking-tighter ${strat.is_active ? 'text-white' : 'text-slate-500'}`}>
                              {strat.strategy.replace('_V1','').replace(/_/g, ' ')}
                            </span>
                            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">
                              {strat.execution_mode || 'PAPER'} MODE
                            </span>
                          </div>
                          
                          <div className="flex gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); openStrategyEditor(strat); }}
                              className="p-2 rounded-xl border transition-colors bg-indigo-500/10 border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20"
                              title="Edit Parameters"
                            >
                              <Settings size={14} />
                            </button>
                            
                            <button 
                                onClick={(e) => { e.stopPropagation(); handleToggleStrategy(strat.id, strat.is_active); }}
                                className={`p-2 rounded-xl border transition-colors ${strat.is_active ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30' : 'bg-slate-800 border-white/5 text-slate-500 hover:bg-slate-700'}`}
                                title={strat.is_active ? "Pause Strategy" : "Activate Strategy"}
                            >
                                <Power size={14} />
                            </button>
                          </div>
                      </div>

                      <p className="text-[10px] text-slate-400 leading-relaxed italic line-clamp-3">
                        &quot;{description}&quot;
                      </p>

                      <div className="grid grid-cols-2 gap-3 mt-2">
                        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-1">Realized PnL</span>
                          <span className={`text-[12px] font-mono font-black ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            ${totalPnL.toFixed(2)}
                          </span>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-1">Realized ROI</span>
                          <span className={`text-[12px] font-mono font-black ${parseFloat(avgRoi) >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>
                            {avgRoi}%
                          </span>
                        </div>
                      </div>

                      {currentAssetStrategies.length > 1 && (
                        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
                          <button 
                            onClick={(e) => { e.stopPropagation(); setCurrentStrategyIndex(prev => (prev - 1 + currentAssetStrategies.length) % currentAssetStrategies.length); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
                          >
                            <ChevronDown size={16} className="rotate-90" />
                          </button>
                          <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">
                            {currentStrategyIndex + 1} / {currentAssetStrategies.length}
                          </span>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setCurrentStrategyIndex(prev => (prev + 1) % currentAssetStrategies.length); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
                          >
                            <ChevronDown size={16} className="-rotate-90" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
            })()}
          </div>

          <div className="dark:bg-slate-950 bg-white border dark:border-white/10 border-slate-300/50 rounded-[2.5rem] flex flex-col flex-grow overflow-hidden shadow-2xl min-h-[300px]">
            <div className="px-6 py-4 border-b dark:border-white/5 border-slate-300/50 text-[10px] font-black uppercase dark:text-slate-500 text-slate-600 flex items-center justify-between">
              <div className="flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Session Logs</div>
              <select
                value={sessionLogAgentFilter}
                onChange={(e) => setSessionLogAgentFilter(e.target.value)}
                className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1 text-[9px] font-bold text-slate-300 outline-none focus:ring-1 focus:ring-indigo-500/50"
              >
                <option value="ALL">All Agents</option>
                <option value="Sniper">Sniper</option>
                <option value="Watchdog">Watchdog</option>
                <option value="Agent Cortex">Agent Cortex</option>
              </select>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-2 flex-grow min-h-[150px] text-slate-400">
                {sessionLogs.filter(log => sessionLogAgentFilter === 'ALL' || log.agent_name === sessionLogAgentFilter).length === 0 ? (
                    <div className="text-slate-600 italic">Awaiting agent activity...</div>
                ) : (
                    sessionLogs.filter(log => sessionLogAgentFilter === 'ALL' || log.agent_name === sessionLogAgentFilter).filter(log => normalizeAssetSymbol(log.asset) === normalizeAssetSymbol(activeAsset)).map((log, i) => {
                        const agentColor = 
                            log.agent_name === 'Sniper' ? 'text-emerald-400' : 
                            log.agent_name === 'Watchdog' ? 'text-rose-400' : 
                            log.agent_name === 'Agent Cortex' ? 'text-indigo-400' : 'text-slate-500';
                        
                        return (
                            <div key={i} className="flex flex-col border-l-2 border-white/5 pl-3 py-1 hover:bg-white/[0.02] transition-colors">
                                <span className={`text-[8px] font-black uppercase tracking-tighter ${agentColor}`}>
                                    {new Date(log.timestamp).toLocaleTimeString()} - {log.agent_name}
                                </span>
                                <span className="text-[9px] text-white/70 whitespace-pre-wrap leading-relaxed">{log.log_message}</span>
                            </div>
                        );
                    })
                )}
            </div>
          </div>
          <div className="dark:bg-slate-950 bg-white border dark:border-white/10 border-slate-300/50 rounded-[2.5rem] flex flex-col flex-grow overflow-hidden shadow-2xl min-h-[500px]">
          <div className="px-6 py-4 border-b dark:border-white/5 border-slate-300/50 text-[10px] font-black uppercase dark:text-slate-500 text-slate-600 flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Nexus Agent</div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-4 flex-grow min-h-[250px]">
              {messages.map(m => (
                <div key={m.id} className={`flex flex-col gap-2 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {m.toolInvocations && m.toolInvocations.map(tool => (
                        <div key={tool.toolCallId} className="text-[9px] text-slate-500 italic bg-black/30 px-3 py-1.5 rounded-lg border border-white/5 flex items-center gap-2">
                            {tool.state === 'result' ? <span className="text-emerald-400 font-bold">✓</span> : <Cpu size={10} className="animate-spin text-indigo-400" />}
                            <span>Nexus executing: <span className="font-bold text-slate-400">{tool.toolName}</span></span>
                        </div>
                    ))}
                    {m.content && (
                        <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${m.role === 'user' ? 'dark:bg-indigo-500/10 bg-indigo-100 dark:text-indigo-300 text-indigo-800 dark:border-indigo-500/20 border-indigo-300/50' : 'dark:bg-slate-900/80 bg-slate-100 dark:text-cyan-400 text-cyan-800 dark:border-white/5 border-slate-300/50'}`}>
                            {m.content}
                        </div>
                    )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleManualSubmit} className="p-4 border-t dark:border-white/5 border-slate-300/50 dark:bg-slate-900/40 bg-slate-100 flex gap-3">
                <input 
                  className="w-full dark:bg-black/50 bg-white dark:border-white/10 border-slate-300/50 rounded-xl px-4 py-3 text-[11px] font-mono dark:text-white text-slate-900 focus:outline-none focus:border-indigo-500/50" 
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

      {/* Strategy Edit Modal */}
      {editModalOpen && editingStrategy && (
        <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-black uppercase text-white">Edit Strategy</h2>
              <button
                onClick={() => setEditModalOpen(false)}
                className="p-1 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X size={18} className="text-slate-400" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Strategy Name */}
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
                  Strategy
                </label>
                <div className="bg-slate-800 border border-white/5 rounded-lg px-3 py-2 text-white text-[10px] font-bold">
                  {editingStrategy.strategy.replace('_V1', '')}
                </div>
              </div>

              {/* Execution Mode */}
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
                  Execution Mode
                </label>
                <select
                  value={editingExecutionMode}
                  onChange={(e) => setEditingExecutionMode(e.target.value)}
                  className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-[10px] font-bold outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="PAPER">Paper Trading</option>
                  <option value="LIVE">Live Trading</option>
                </select>
              </div>

              {/* Parameters */}
              {Object.keys(editingParameters).length > 0 ? (
                <div className="border-t border-white/5 pt-4">
                  <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Parameters</h3>
                  <div className="space-y-3">
                    {Object.entries(editingParameters).map(([key, value]) => {
                      const isTimeframe = key.toLowerCase().includes('_tf') || key.toLowerCase().includes('timeframe');
                      const timeframeOptions = ['1m', '5m', '15m', '30m', '1hr', '2hr', '4hr', '1d'];
                      
                      return (
                        <div key={key}>
                          <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest block mb-1">
                            {value.label || key}
                          </label>
                          {isTimeframe ? (
                            <select
                              value={editingParameters[key].default}
                              onChange={(e) => setEditingParameters(prev => ({
                                ...prev,
                                [key]: { ...prev[key], default: e.target.value }
                              }))}
                              className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-[9px] outline-none focus:ring-1 focus:ring-indigo-500/50"
                            >
                              <option value="">Select Timeframe</option>
                              {timeframeOptions.map(tf => (
                                <option key={tf} value={tf}>{tf}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={value.type}
                              value={editingParameters[key].default}
                              onChange={(e) => setEditingParameters(prev => ({
                                ...prev,
                                [key]: { ...prev[key], default: value.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value }
                              }))}
                              className="w-full bg-slate-800 border border-white/5 rounded-lg px-3 py-2 text-white text-[9px] outline-none focus:ring-1 focus:ring-indigo-500/50"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="text-center py-4 text-slate-600 text-[9px] italic">
                  No parameters to configure
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 border-t border-white/5 pt-4 mt-4">
                <button
                  onClick={() => setEditModalOpen(false)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all border border-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={saveStrategyChanges}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all shadow-lg shadow-indigo-500/20"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}