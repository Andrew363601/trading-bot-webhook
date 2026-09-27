import React, { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession, useSupabaseClient } from '@supabase/auth-helpers-react';
import {
  ArrowLeft,
  Code,
  Layers,
  Play,
  Lock,
  Sparkles,
  Clock,
  BookOpen,
  FileCode,
  CheckCircle,
  ExternalLink,
  ChevronRight,
  Shield,
  Activity,
  AlertCircle,
  RotateCw,
  TrendingUp,
  TrendingDown,
  DollarSign,
  BarChart2
} from 'lucide-react';
import {
  createChart,
  CandlestickSeries,
  AreaSeries,
  createSeriesMarkers,
  CrosshairMode
} from 'lightweight-charts';
import { STUDIO_TIERS, hasStudioAccess } from '../lib/entitlements.js';
import StudioChat from '../components/StudioChat.js';
import { MessageSquare, X } from 'lucide-react';

export default function StudioPage() {
  const router = useRouter();
  const session = useSession();
  const supabase = useSupabaseClient();

  const [activeTab, setActiveTab] = useState('LIBRARY'); // 'LIBRARY' | 'BUILDER' | 'BACKTEST'
  const [loading, setLoading] = useState(true);
  const [billingTier, setBillingTier] = useState(null);
  const [myStrategies, setMyStrategies] = useState([]);
  const [publicStrategies, setPublicStrategies] = useState([]);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [versions, setVersions] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');

  // Backtest configuration & state
  const [backtestProduct, setBacktestProduct] = useState('BTC-USD');
  const [macroTf, setMacroTf] = useState('ONE_HOUR');
  const [triggerTf, setTriggerTf] = useState('FIVE_MINUTE');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  const [backtesting, setBacktesting] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestError, setBacktestError] = useState('');
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  // Lightweight-Charts refs
  const chartContainerRef = useRef(null);
  const equityContainerRef = useRef(null);
  const candleChartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const markersPluginRef = useRef(null);
  const priceLinesRef = useRef([]);
  const equityChartRef = useRef(null);
  const equitySeriesRef = useRef(null);

  // 1. Fetch user billing tier
  useEffect(() => {
    async function fetchTier() {
      if (!session?.user) return;
      try {
        const { data: userLink } = await supabase
          .from('tenant_users')
          .select('tenants(billing_tier)')
          .eq('auth_user_id', session.user.id)
          .eq('is_active', true)
          .maybeSingle();

        const tier = userLink?.tenants?.billing_tier || 'FREE_TRIAL';
        setBillingTier(tier);
      } catch (err) {
        console.error('Error fetching billing tier:', err);
      }
    }
    fetchTier();
  }, [session, supabase]);

  // 2. Fetch strategy library
  const fetchLibrary = async () => {
    if (!session?.access_token) return;
    try {
      setLoading(true);
      setErrorMsg('');
      const res = await fetch('/api/strategy-library', {
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to fetch library (${res.status})`);
      }
      const data = await res.json();
      setMyStrategies(data.my_strategies || []);
      setPublicStrategies(data.public_library || []);
    } catch (err) {
      console.error('Error loading library:', err);
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session?.access_token) {
      fetchLibrary();
    }
  }, [session]);

  // 3. Load specific strategy by query param or selection
  const loadStrategyDetail = async (strategyName, targetRunId) => {
    if (!session?.access_token || !strategyName) return;
    try {
      const res = await fetch(`/api/strategy-library?name=${encodeURIComponent(strategyName)}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedStrategy(data.strategy);
        setVersions(data.versions || []);
        if (data.strategy?.latest_backtest) {
          setBacktestResult(data.strategy.latest_backtest);
        }
        if (targetRunId) {
          setActiveTab('BACKTEST');
        } else {
          setActiveTab('BUILDER');
        }
      }
    } catch (err) {
      console.error('Failed to load strategy details:', err);
    }
  };

  useEffect(() => {
    if (router.isReady && router.query.strategy && session?.access_token) {
      loadStrategyDetail(router.query.strategy, router.query.run);
    }
  }, [router.isReady, router.query.strategy, router.query.run, session]);

  // 4. Run Backtest
  const handleRunBacktest = async () => {
    if (!selectedStrategy) {
      setBacktestError('Please select a strategy from the Library first.');
      return;
    }
    if (backtesting) return;

    try {
      setBacktesting(true);
      setBacktestError('');
      setBacktestResult(null);

      const startEpoch = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
      const endEpoch = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000);

      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({
          strategy_id: selectedStrategy.id,
          name: selectedStrategy.name,
          product: backtestProduct,
          macro_tf: macroTf,
          trigger_tf: triggerTf,
          start: startEpoch,
          end: endEpoch
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Backtest failed (${res.status})`);
      }

      setBacktestResult(data);
      // Refresh library in background to update latest_backtest
      fetchLibrary();
    } catch (err) {
      console.error('Backtest error:', err);
      setBacktestError(err.message);
    } finally {
      setBacktesting(false);
    }
  };

  // 5. Lightweight-Charts v5 Visual Replay Mounting
  useEffect(() => {
    if (activeTab !== 'BACKTEST') return;
    if (!chartContainerRef.current) return;

    if (candleChartRef.current) {
      candleChartRef.current.remove();
      candleChartRef.current = null;
    }
    if (equityChartRef.current) {
      equityChartRef.current.remove();
      equityChartRef.current = null;
    }
    priceLinesRef.current = [];

    const mainChart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#94a3b8'
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(255, 255, 255, 0.1)'
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        autoScale: true
      },
      autoSize: true
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444'
    });

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    candleChartRef.current = mainChart;
    candleSeriesRef.current = candleSeries;
    markersPluginRef.current = markersPlugin;

    if (equityContainerRef.current) {
      const eqChart = createChart(equityContainerRef.current, {
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: '#94a3b8'
        },
        grid: {
          vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
          horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
        },
        crosshair: { mode: CrosshairMode.Normal },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          borderColor: 'rgba(255, 255, 255, 0.1)'
        },
        rightPriceScale: {
          borderColor: 'rgba(255, 255, 255, 0.1)',
          autoScale: true
        },
        autoSize: true
      });

      const eqSeries = eqChart.addSeries(AreaSeries, {
        topColor: 'rgba(99, 102, 241, 0.4)',
        bottomColor: 'rgba(99, 102, 241, 0.02)',
        lineColor: '#6366f1',
        lineWidth: 2
      });

      equityChartRef.current = eqChart;
      equitySeriesRef.current = eqSeries;
    }

    return () => {
      if (candleChartRef.current) {
        candleChartRef.current.remove();
        candleChartRef.current = null;
      }
      if (equityChartRef.current) {
        equityChartRef.current.remove();
        equityChartRef.current = null;
      }
      priceLinesRef.current = [];
    };
  }, [activeTab]);

  // 6. Populate Chart Data, Markers, Price Lines, and Equity Curve
  useEffect(() => {
    if (activeTab !== 'BACKTEST') return;
    if (!candleSeriesRef.current || !candleChartRef.current) return;

    const rawCandles = backtestResult?.trigger_candles || [];
    if (!rawCandles || rawCandles.length === 0) {
      candleSeriesRef.current.setData([]);
      if (markersPluginRef.current) markersPluginRef.current.setMarkers([]);
      if (equitySeriesRef.current) equitySeriesRef.current.setData([]);
      return;
    }

    const formattedCandles = rawCandles.map((c) => ({
      time: Math.floor(Number(c.time)),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    })).sort((a, b) => a.time - b.time);

    candleSeriesRef.current.setData(formattedCandles);

    const minTime = formattedCandles[0].time;
    const maxTime = formattedCandles[formattedCandles.length - 1].time;

    priceLinesRef.current.forEach((pl) => {
      try {
        candleSeriesRef.current?.removePriceLine(pl);
      } catch (e) {}
    });
    priceLinesRef.current = [];

    const markers = [];
    const trades = backtestResult?.trades || [];

    trades.forEach((t) => {
      const entrySec = Math.floor(Number(t.entry_time));
      const exitSec = t.exit_time ? Math.floor(Number(t.exit_time)) : null;

      if (entrySec >= minTime && entrySec <= maxTime) {
        const isLong = t.side === 'LONG';
        markers.push({
          time: entrySec,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? '#10b981' : '#ef4444',
          shape: isLong ? 'arrowUp' : 'arrowDown',
          text: t.side + ' $' + t.entry_price
        });
      }

      if (exitSec && exitSec >= minTime && exitSec <= maxTime) {
        const isWin = (t.pnl_usd || 0) >= 0;
        const color = isWin ? '#10b981' : '#f43f5e';
        markers.push({
          time: exitSec,
          position: t.side === 'LONG' ? 'aboveBar' : 'belowBar',
          color: color,
          shape: isWin ? 'arrowUp' : 'arrowDown',
          text: (t.exit_reason || 'EXIT') + ' (' + (isWin ? '+' : '') + '$' + (t.pnl_usd || 0).toFixed(2) + ')'
        });
      }
    });

    markers.sort((a, b) => a.time - b.time);
    if (markersPluginRef.current) {
      markersPluginRef.current.setMarkers(markers);
    }

    const lastTrade = trades[trades.length - 1];
    if (lastTrade && !lastTrade.exit_time) {
      if (lastTrade.tp_price) {
        const tpLine = candleSeriesRef.current.createPriceLine({
          price: Number(lastTrade.tp_price),
          color: '#10b981',
          lineWidth: 2,
          lineStyle: 2,
          title: 'OPEN TP'
        });
        priceLinesRef.current.push(tpLine);
      }
      if (lastTrade.sl_price) {
        const slLine = candleSeriesRef.current.createPriceLine({
          price: Number(lastTrade.sl_price),
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: 2,
          title: 'OPEN SL'
        });
        priceLinesRef.current.push(slLine);
      }
    }

    candleChartRef.current.timeScale().fitContent();

    const rawEquity = backtestResult?.equity_curve || [];
    if (equitySeriesRef.current && rawEquity.length > 0) {
      const formattedEquity = rawEquity.map((pt) => ({
        time: Math.floor(Number(pt.t)),
        value: Number(pt.equity)
      })).sort((a, b) => a.time - b.time);

      equitySeriesRef.current.setData(formattedEquity);
      equityChartRef.current?.timeScale().fitContent();
    }
  }, [backtestResult, activeTab]);

  const handleTradeClick = (trade, idx) => {
    setSelectedTradeIdx(idx);
    if (!candleChartRef.current || !trade.entry_time) return;

    try {
      const entrySec = Math.floor(Number(trade.entry_time));
      const exitSec = trade.exit_time ? Math.floor(Number(trade.exit_time)) : entrySec + 3600;
      const buffer = Math.max(3600, (exitSec - entrySec) * 2);

      candleChartRef.current.timeScale().setVisibleRange({
        from: entrySec - buffer,
        to: exitSec + buffer
      });
    } catch (err) {
      console.warn('Scroll to trade error:', err.message);
    }
  };

  const isUnlocked = hasStudioAccess(billingTier);

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 sm:p-8 font-sans">
      <Head>
        <title>Nexus | Strategy Studio</title>
      </Head>

      <div className="max-w-7xl mx-auto space-y-6 mt-6">
        {/* Top Navigation */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/5 pb-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-slate-500 hover:text-white transition-colors text-xs font-black uppercase tracking-widest"
            >
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Link>
            <div className="h-4 w-[1px] bg-white/10" />
            <h1 className="text-xl sm:text-2xl font-black italic tracking-tighter uppercase bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              Strategy Studio
            </h1>
          </div>

          {/* Tab Selector */}
          <div className="flex items-center gap-1 bg-slate-900/60 p-1 rounded-xl border border-white/5">
            <button
              onClick={() => setActiveTab('LIBRARY')}
              className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
                activeTab === 'LIBRARY'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" /> Library
            </button>
            <button
              onClick={() => setActiveTab('BUILDER')}
              className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
                activeTab === 'BUILDER'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Code className="w-3.5 h-3.5" /> Builder
            </button>
            <button
              onClick={() => setActiveTab('BACKTEST')}
              className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
                activeTab === 'BACKTEST'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Play className="w-3.5 h-3.5" /> Backtest
            </button>
            <button
              onClick={() => setMobileChatOpen(!mobileChatOpen)}
              className="lg:hidden px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-1.5 text-slate-400 hover:text-white hover:bg-white/5 border-l border-white/10 ml-1"
            >
              <MessageSquare className="w-3.5 h-3.5 text-indigo-400" /> Chat
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-6">
            {/* Tier Gate Lock Banner */}
        {!isUnlocked && billingTier && (
          <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 p-5 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider text-amber-300">
                  Strategy Studio — Pro Tier Required
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Your current tier ({billingTier}) allows browsing public strategies. Upgrading to PRO or higher unlocks custom strategy building, AI chat saves, and backtesting.
                </p>
              </div>
            </div>
            <Link
              href="/plans"
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-widest rounded-xl transition-all whitespace-nowrap shadow-lg shadow-amber-500/10"
            >
              Upgrade Plan
            </Link>
          </div>
        )}

        {/* TAB 1: LIBRARY */}
        {activeTab === 'LIBRARY' && (
          <div className="space-y-8">
            {/* MY STRATEGIES */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-black uppercase tracking-widest text-slate-400">
                    My Strategies
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Tenant-owned algorithms staged in your private library.
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-500 bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
                  {myStrategies.length} strategies
                </span>
              </div>

              {myStrategies.length === 0 ? (
                <div className="bg-slate-900/40 border border-white/5 rounded-2xl p-10 text-center space-y-3">
                  <FileCode className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-sm font-medium text-slate-400">
                    No custom strategies yet — ask Nexus in chat to build one, or create your first strategy.
                  </p>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300 transition-colors pt-2"
                  >
                    Open Nexus Chat <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {myStrategies.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => {
                        setSelectedStrategy(item);
                        loadStrategyDetail(item.name);
                      }}
                      className="group cursor-pointer bg-slate-900/50 hover:bg-slate-900/80 border border-white/5 hover:border-indigo-500/30 rounded-2xl p-5 transition-all space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-sm text-white group-hover:text-indigo-300 transition-colors">
                            {item.display_name || item.name}
                          </h3>
                          <span className="text-[10px] font-mono text-slate-500">
                            {item.name}
                          </span>
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                          v{item.version}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400 line-clamp-2 min-h-[32px]">
                        {item.description || 'No description provided.'}
                      </p>

                      <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[10px] text-slate-500">
                        <span className="uppercase tracking-widest font-bold">
                          {item.status || 'draft'}
                        </span>
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3" />
                          {new Date(item.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* PUBLIC LIBRARY */}
            <div className="space-y-4 pt-4 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-black uppercase tracking-widest text-slate-400">
                    Public Library
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Community and platform algorithms available for inspection and cloning.
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-500 bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
                  {publicStrategies.length} public
                </span>
              </div>

              {publicStrategies.length === 0 ? (
                <div className="bg-slate-900/30 border border-white/5 rounded-2xl p-8 text-center text-xs text-slate-500">
                  No public strategies published yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {publicStrategies.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => {
                        setSelectedStrategy(item);
                        loadStrategyDetail(item.name);
                      }}
                      className="group cursor-pointer bg-slate-900/40 hover:bg-slate-900/70 border border-white/5 hover:border-cyan-500/30 rounded-2xl p-5 transition-all space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-sm text-white group-hover:text-cyan-300 transition-colors">
                            {item.display_name || item.name}
                          </h3>
                          <span className="text-[10px] font-mono text-slate-500">
                            community
                          </span>
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                          v{item.version}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400 line-clamp-2 min-h-[32px]">
                        {item.description || 'Public community algorithm.'}
                      </p>

                      <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[10px] text-slate-500">
                        <span className="uppercase tracking-widest font-bold text-cyan-400">
                          PUBLIC
                        </span>
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3" />
                          {new Date(item.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: BUILDER */}
        {activeTab === 'BUILDER' && (
          <div className="space-y-6">
            {selectedStrategy ? (
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                {/* Code Viewer Panel */}
                <div className="lg:col-span-3 space-y-4">
                  <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <h2 className="text-lg font-bold text-white">
                          {selectedStrategy.display_name || selectedStrategy.name}
                        </h2>
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          v{selectedStrategy.version}
                        </span>
                        <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded bg-white/5 text-slate-400">
                          {selectedStrategy.status || 'draft'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        {selectedStrategy.description || 'No description provided.'}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setActiveTab('BACKTEST')}
                        className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-colors flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5" /> Backtest
                      </button>
                    </div>
                  </div>

                  <div className="bg-slate-950 border border-white/5 rounded-2xl p-4 overflow-hidden">
                    <div className="flex items-center justify-between pb-3 border-b border-white/5 mb-3 text-xs text-slate-500">
                      <span className="font-mono text-[11px]">{selectedStrategy.name}.js</span>
                      <span className="text-[10px] uppercase tracking-widest">
                        Strategy Studio Engine • Active
                      </span>
                    </div>
                    <pre className="font-mono text-xs text-indigo-200/90 overflow-x-auto p-2 bg-slate-900/50 rounded-xl leading-relaxed whitespace-pre">
                      <code>{selectedStrategy.code || '// No code found.'}</code>
                    </pre>
                  </div>
                </div>

                {/* Sidebar: Version History & Metadata */}
                <div className="space-y-4">
                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-5 space-y-4">
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <Layers className="w-3.5 h-3.5 text-indigo-400" /> Version History
                    </h3>

                    {versions.length === 0 ? (
                      <p className="text-xs text-slate-500">No version history recorded.</p>
                    ) : (
                      <div className="space-y-2">
                        {versions.map((ver) => (
                          <div
                            key={ver.id}
                            className={`p-3 rounded-xl border transition-all text-xs space-y-1 ${
                              ver.version === selectedStrategy.version
                                ? 'bg-indigo-500/10 border-indigo-500/30 text-white'
                                : 'bg-slate-900/30 border-white/5 text-slate-400'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold font-mono">v{ver.version}</span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                {new Date(ver.created_at).toLocaleDateString()}
                              </span>
                            </div>
                            {ver.change_note && (
                              <p className="text-[11px] text-slate-400 italic">
                                {ver.change_note}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-900/30 border border-white/5 rounded-2xl p-5 space-y-3 text-xs text-slate-400">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 block">
                      Strategy Contract
                    </span>
                    <p className="text-[11px] leading-relaxed">
                      Must define:
                      <code className="block bg-black/40 text-indigo-300 p-2 rounded-lg my-1.5 font-mono text-[10px]">
                        export async function run(macroCandles, triggerCandles, parameters)
                      </code>
                      Strategies saved to the library remain inactive until explicitly tested and deployed.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-900/40 border border-white/5 rounded-2xl p-12 text-center space-y-4">
                <Code className="w-10 h-10 text-slate-600 mx-auto" />
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                  No Strategy Selected
                </h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Select a strategy from the Library tab to view its architecture, source code, and version history.
                </p>
                <button
                  onClick={() => setActiveTab('LIBRARY')}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-colors inline-flex items-center gap-2"
                >
                  <BookOpen className="w-3.5 h-3.5" /> Open Library
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: BACKTEST ENGINE (PUSH AM46) */}
        {activeTab === 'BACKTEST' && (
          <div className="space-y-6">
            {/* Backtest Control Header */}
            <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/5">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-indigo-400" />
                    Backtest Parameters
                    {selectedStrategy && (
                      <span className="text-xs font-mono font-normal text-indigo-300 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                        {selectedStrategy.display_name || selectedStrategy.name} (v{selectedStrategy.version})
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Simulate strategy execution on unauthenticated Coinbase historical candles with closed-bar parity.
                  </p>
                </div>

                {!selectedStrategy && (
                  <button
                    onClick={() => setActiveTab('LIBRARY')}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition-colors inline-flex items-center gap-1.5"
                  >
                    Select Strategy <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Form Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                    Asset / Product
                  </label>
                  <input
                    type="text"
                    value={backtestProduct}
                    onChange={(e) => setBacktestProduct(e.target.value)}
                    placeholder="BTC-USD"
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                    Trigger TF
                  </label>
                  <select
                    value={triggerTf}
                    onChange={(e) => setTriggerTf(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="ONE_MINUTE">ONE_MINUTE (1m)</option>
                    <option value="FIVE_MINUTE">FIVE_MINUTE (5m)</option>
                    <option value="FIFTEEN_MINUTE">FIFTEEN_MINUTE (15m)</option>
                    <option value="THIRTY_MINUTE">THIRTY_MINUTE (30m)</option>
                    <option value="ONE_HOUR">ONE_HOUR (1h)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                    Macro TF
                  </label>
                  <select
                    value={macroTf}
                    onChange={(e) => setMacroTf(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="THIRTY_MINUTE">THIRTY_MINUTE (30m)</option>
                    <option value="ONE_HOUR">ONE_HOUR (1h)</option>
                    <option value="TWO_HOUR">TWO_HOUR (2h)</option>
                    <option value="SIX_HOUR">SIX_HOUR (6h)</option>
                    <option value="ONE_DAY">ONE_DAY (1d)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                    End Date
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Action Button */}
              <div className="flex items-center justify-between pt-2">
                <div className="text-[11px] text-slate-500 flex items-center gap-1.5 font-mono">
                  <Shield className="w-3.5 h-3.5 text-indigo-400" />
                  Isolated VM sandbox • 5 req/s rate limit • SL-priority intrabar resolution
                </div>

                <button
                  onClick={handleRunBacktest}
                  disabled={backtesting || !selectedStrategy}
                  className={`px-5 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
                    backtesting
                      ? 'bg-indigo-600/50 text-indigo-200 cursor-not-allowed'
                      : !selectedStrategy
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 active:scale-95'
                  }`}
                >
                  {backtesting ? (
                    <>
                      <RotateCw className="w-3.5 h-3.5 animate-spin" /> Running Simulation...
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" /> Run Backtest
                    </>
                  )}
                </button>
              </div>

              {backtestError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{backtestError}</span>
                </div>
              )}
            </div>

            {/* Backtest Visual Replay Canvas (PUSH AM47) */}
            <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">
                    Visual Replay Canvas (Trigger TF)
                  </h3>
                  {backtestResult?.trigger_candles && (
                    <span className="text-[10px] font-mono text-slate-500">
                      ({backtestResult.trigger_candles.length} bars)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" /> Long Entry
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-rose-500" /> Short Entry
                  </span>
                </div>
              </div>

              {/* Main Candlestick Replay Pane */}
              <div className="w-full h-[400px] relative bg-slate-950/80 rounded-xl overflow-hidden border border-white/5">
                <div ref={chartContainerRef} className="w-full h-full" />
                {(!backtestResult || !backtestResult.trigger_candles || backtestResult.trigger_candles.length === 0) && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs text-xs text-slate-500 font-mono">
                    Run a backtest simulation to view interactive candle replay & trade markers.
                  </div>
                )}
              </div>

              {/* Equity Curve Sub-pane */}
              <div className="space-y-1 pt-2">
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-slate-500">
                  <span>Equity Curve (,000 baseline)</span>
                </div>
                <div className="w-full h-[140px] relative bg-slate-950/80 rounded-xl overflow-hidden border border-white/5">
                  <div ref={equityContainerRef} className="w-full h-full" />
                </div>
              </div>
            </div>

            {/* Backtest Results Display */}
            {backtestResult && backtestResult.summary && (
              <div className="space-y-6">
                {/* Metric Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Total Trades
                    </span>
                    <div className="text-xl font-bold font-mono text-white">
                      {backtestResult.summary.total_trades}
                    </div>
                  </div>

                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Win Rate
                    </span>
                    <div className="text-xl font-bold font-mono text-cyan-400">
                      {(backtestResult.summary.win_rate * 100).toFixed(1)}%
                    </div>
                  </div>

                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Net PnL
                    </span>
                    <div
                      className={`text-xl font-bold font-mono flex items-center gap-1 ${
                        backtestResult.summary.total_pnl_usd >= 0 ? 'text-green-400' : 'text-rose-400'
                      }`}
                    >
                      {backtestResult.summary.total_pnl_usd >= 0 ? '+' : ''}$
                      {backtestResult.summary.total_pnl_usd.toFixed(2)}
                    </div>
                  </div>

                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Max Drawdown
                    </span>
                    <div className="text-xl font-bold font-mono text-rose-400">
                      -${backtestResult.summary.max_drawdown_usd?.toFixed(2) || '0.00'}
                    </div>
                  </div>

                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Expectancy
                    </span>
                    <div
                      className={`text-xl font-bold font-mono ${
                        backtestResult.summary.expectancy_usd >= 0 ? 'text-green-400' : 'text-rose-400'
                      }`}
                    >
                      ${backtestResult.summary.expectancy_usd?.toFixed(2) || '0.00'}
                    </div>
                  </div>

                  <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-4 space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Avg Hold Bars
                    </span>
                    <div className="text-xl font-bold font-mono text-indigo-300">
                      {backtestResult.summary.avg_hold_bars}
                    </div>
                  </div>
                </div>

                {/* Trade Logs Table */}
                <div className="bg-slate-900/50 border border-white/5 rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between pb-2 border-b border-white/5">
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <Activity className="w-3.5 h-3.5 text-indigo-400" /> Simulated Trade History
                    </h3>
                    <span className="text-xs font-mono text-slate-500">
                      {backtestResult.trades?.length || 0} executions
                    </span>
                  </div>

                  {(!backtestResult.trades || backtestResult.trades.length === 0) ? (
                    <div className="text-center py-8 text-xs text-slate-500">
                      Zero trades executed in this range. The strategy did not emit actionable triggers.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-slate-950/60 text-slate-400 border-b border-white/5">
                          <tr>
                            <th className="py-2.5 px-3">Side</th>
                            <th className="py-2.5 px-3">Entry Time</th>
                            <th className="py-2.5 px-3">Entry Price</th>
                            <th className="py-2.5 px-3">Exit Time</th>
                            <th className="py-2.5 px-3">Exit Price</th>
                            <th className="py-2.5 px-3">Reason</th>
                            <th className="py-2.5 px-3">Hold</th>
                            <th className="py-2.5 px-3 text-right">Net PnL (USD)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {backtestResult.trades.map((t, idx) => (
                            <tr
                                key={idx}
                                onClick={() => handleTradeClick(t, idx)}
                                className={"cursor-pointer transition-colors " + (selectedTradeIdx === idx ? "bg-indigo-600/20 border-l-2 border-indigo-400" : "hover:bg-white/[0.02]")}
                              >
                              <td className="py-2.5 px-3">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    t.side === 'LONG'
                                      ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                  }`}
                                >
                                  {t.side}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-slate-400">
                                {new Date(t.entry_time * 1000).toLocaleString()}
                              </td>
                              <td className="py-2.5 px-3 text-white">${t.entry_price}</td>
                              <td className="py-2.5 px-3 text-slate-400">
                                {new Date(t.exit_time * 1000).toLocaleString()}
                              </td>
                              <td className="py-2.5 px-3 text-white">${t.exit_price}</td>
                              <td className="py-2.5 px-3">
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300">
                                  {t.exit_reason}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-slate-400">{t.bars_held} bars</td>
                              <td
                                className={`py-2.5 px-3 text-right font-bold ${
                                  t.pnl_usd >= 0 ? 'text-green-400' : 'text-rose-400'
                                }`}
                              >
                                {t.pnl_usd >= 0 ? '+' : ''}${t.pnl_usd.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
          </div>

          {/* Desktop Right Panel: Embedded StudioChat (lg:w-96) */}
          <div className="hidden lg:block lg:col-span-4 sticky top-6">
            <div className="h-[760px]">
              <StudioChat
                session={session}
                strategyName={selectedStrategy?.name}
                onStrategyUpdated={() => {
                  if (selectedStrategy?.name) {
                    loadStrategyDetail(selectedStrategy.name);
                    fetchLibrary();
                  }
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Drawer StudioChat */}
      {mobileChatOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/80 backdrop-blur-xs lg:hidden">
          <div className="w-full max-w-lg h-[550px] bg-slate-950 border border-white/10 rounded-2xl overflow-hidden relative shadow-2xl flex flex-col">
            <button
              onClick={() => setMobileChatOpen(false)}
              className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex-1 overflow-hidden">
              <StudioChat
                session={session}
                strategyName={selectedStrategy?.name}
                onStrategyUpdated={() => {
                  if (selectedStrategy?.name) {
                    loadStrategyDetail(selectedStrategy.name);
                    fetchLibrary();
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
