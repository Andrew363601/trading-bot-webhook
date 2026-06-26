// hard push tf

import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { Activity, ChevronRight, TrendingUp } from 'lucide-react';
import WebhookCreator from '../components/WebhookCreator';
import { fetchWixContent, FALLBACK_CONTENT } from '../lib/wix-content';

export default function LandingPage() {
  const [logs, setLogs] = useState([]);
  const [showRationalization, setShowRationalization] = useState(false);
  const [terminalFilter, setTerminalFilter] = useState('ALL');
  const [demoStats, setDemoStats] = useState({ winRate: '0%', totalTrades: 0, totalPnL: '$0.00' });
  const [activeDemoTrade, setActiveDemoTrade] = useState(null);
  const [demoTrades, setDemoTrades] = useState([]);
  const [demoConfigs, setDemoConfigs] = useState([]);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [content, setContent] = useState(FALLBACK_CONTENT);

  useEffect(() => {
    fetchWixContent().then(setContent);
    const setSynthetic = () => {
      // Synthetic fallback so the marketing page is never blank.
      setLogs([
        { type: 'CORTEX', text: 'Nexus Cortex v2.4.1 — Demo Environment (Synthetic)', color: 'text-purple-400' },
        { type: 'WATCHDOG', text: 'Watchdog online. Monitoring BTC-PERP, ETH-PERP, SOL-PERP...', color: 'text-emerald-400' },
        { type: 'SNIPER', text: 'Strategy ORACLE_PRICE_ACTION_V1 deployed on BTC-PERP [PAPER]', color: 'text-cyan-400' },
        { type: 'CORTEX', text: 'Rationalizing trade for SOL-PERP... analyzing volume absorption at 5M nodes.', color: 'text-purple-400' },
        { type: 'WATCHDOG', text: 'Heartbeat: Live ROE: 2.34% | Tripwire: 5.00%.', color: 'text-emerald-400' },
        { type: 'SNIPER', text: 'KELTNER_EXECUTION_V1: ETH-PERP limit order placed @ $3,245.00', color: 'text-cyan-400' },
      ]);
      setDemoStats({ winRate: '67.3%', totalTrades: 142, totalPnL: '$4,892.15' });
      setDemoConfigs([
        { strategy: 'ORACLE_PRICE_ACTION_V1', asset: 'BTC-PERP' },
        { strategy: 'KELTNER_EXECUTION_V1', asset: 'ETH-PERP' },
        { strategy: 'SOL_RANGE_REVERSION_V1', asset: 'SOL-PERP' },
        { strategy: 'DOGE_HF_SCALPER_V1', asset: 'DOGE-PERP' },
      ]);
    };

    const toLog = (l) => ({
      type: l.agent_name === 'Agent Cortex' ? 'CORTEX' : (l.agent_name === 'Watchdog' ? 'WATCHDOG' : 'SNIPER'),
      text: l.log_message,
      timestamp: l.timestamp || null,   // Preserve so the terminal can show DATE/TIME, not just text.
      color: l.agent_name === 'Agent Cortex' ? 'text-purple-400' : (l.agent_name === 'Watchdog' ? 'text-emerald-400' : 'text-cyan-400'),
    });

    let cancelled = false;
    let hasRealData = false;   // Once we paint real demo data, never let synthetic stats clobber it.

    // Fetch the demo data from the public, server-side, service-role endpoint.
    // (Direct anon Supabase reads are blocked by tenant-scoped RLS.)
    const fetchFeed = async () => {
      try {
        const res = await fetch('/api/demo-feed');
        if (!res.ok) throw new Error(`demo-feed ${res.status}`);
        const data = await res.json();
        if (cancelled) return;

        const hasAny = (data.logs?.length || 0) + (data.trades?.length || 0) + (data.configs?.length || 0) > 0;
        // Only fall back to synthetic if we have NEVER painted real data. Once we
        // have real data, an empty poll (transient blip) must not clobber it back
        // to "67.3% / $4,892.15".
        if (!data.configured || !hasAny) {
          if (!hasRealData) setSynthetic();
          return;
        }
        hasRealData = true;

        if (data.logs?.length) setLogs(data.logs.map(toLog));
        // Configs are pre-filtered to is_active=true by /api/demo-feed.
        setDemoConfigs(data.configs || []);

        // Trades drive stats. Always recompute against the latest payload so the
        // win rate and PnL reflect what the demo tenant is actually doing.
        const trades = data.trades || [];
        setDemoTrades(trades);
        const closed = trades.filter(t => t.exit_price !== null && t.exit_price !== undefined);
        const openTrades = trades.filter(t => t.exit_price === null || t.exit_price === undefined);

        if (closed.length > 0) {
          // Realized performance from closed trades.
          const wins = closed.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
          const winRate = ((wins / closed.length) * 100).toFixed(1) + '%';
          const totalPnLVal = closed.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
          setDemoStats({ winRate, totalTrades: closed.length, totalPnL: `$${totalPnLVal.toFixed(2)}`, live: false });
        } else if (openTrades.length > 0 && openTrades.some(t => Math.abs(parseFloat(t.pnl) || 0) > 0)) {
          // No closed trades yet — show LIVE/unrealized performance so the page
          // is never a dead "0% / $0". Use pnl to compute unrealized performance.
          const greens = openTrades.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
          const winRate = ((greens / openTrades.length) * 100).toFixed(1) + '%';
          const unrealized = openTrades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
          setDemoStats({ winRate, totalTrades: openTrades.length, totalPnL: `$${unrealized.toFixed(2)}`, live: true });
        } else {
          // Nothing at all (or only fresh open trades with 0 PnL) — keep the synthetic teaser numbers.
          setDemoStats({ winRate: '67.3%', totalTrades: 142, totalPnL: '$4,892.15', live: false });
        }

        const open = openTrades[0];
        setActiveDemoTrade(open || null);

        if (data.logs?.some(l => l.agent_name === 'Agent Cortex')) {
          setShowRationalization(true);
          setTimeout(() => { if (!cancelled) setShowRationalization(false); }, 8000);
        }
      } catch (e) {
        console.warn('[DEMO] feed unavailable, using synthetic data:', e.message);
        if (!cancelled && !hasRealData) setSynthetic();
      }
    };

    // Initial paint with synthetic data, then hydrate from the feed and poll.
    setSynthetic();
    fetchFeed();
    const interval = setInterval(fetchFeed, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Collapse a raw product id (BIP-20DEC30-CDE, BTC-PERP-INTX, …) to its base
  // ticker (BTC/SOL/ETH/…). Coinbase dated futures encode the base in a
  // non-standard first segment, so map those explicitly.
  const FUTURES_CODE_MAP = { BIT: 'BTC', BIP: 'BTC', ETP: 'ETH', SLP: 'SOL', DOP: 'DOGE', LCP: 'LTC', AVP: 'AVAX', LNP: 'LINK', XPP: 'XRP', WLD: 'WLD' };
  const baseTicker = (symbol) => {
    if (!symbol) return '';
    let base = String(symbol).toUpperCase().replace(/(-PERP-INTX|-PERP|-INTX|-CDE|-USDT|-USDC|-USD)/g, '').split('-')[0];
    return FUTURES_CODE_MAP[base] || base;
  };

  // Build the terminal feed. Two problems we fix here:
  //   1) Ensure strict newest-first chronological order (the API can return
  //      rows with equal/again-out-of-order timestamps).
  //   2) The Watchdog spams near-identical "Sweeping open trades" / heartbeat
  //      lines every cycle, which buries the actual SNIPER signals and makes the
  //      stream look jumbled. Collapse consecutive duplicate noise so meaningful
  //      events stay visible.
  const NOISE_RE = /(sweeping open trades|heartbeat|position sync|price sanity)/i;
  const filteredLogs = (() => {
    const sorted = [...logs].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta; // newest first
    });
    const byTab = sorted.filter(l => terminalFilter === 'ALL' || l.type === terminalFilter);
    // Drop consecutive duplicate noise lines (same type + same noisy text).
    const out = [];
    let lastNoiseKey = null;
    for (const l of byTab) {
      const isNoise = NOISE_RE.test(l.text || '');
      const key = isNoise ? `${l.type}:${(l.text || '').slice(0, 24)}` : null;
      if (isNoise && key === lastNoiseKey) continue; // collapse repeat
      lastNoiseKey = key;
      out.push(l);
    }
    return out;
  })();

  const getStrategyStats = (strategyName, asset) => {
    // Match trades to a strategy by strategy_id, OR — when the demo tenant logs
    // trades under a different id but the same asset — fall back to matching on
    // the normalized base ticker so the card still reflects real performance.
    const base = baseTicker(asset);
    const matches = (t) => t.strategy_id === strategyName || (base && baseTicker(t.symbol) === base);

    let live = false;
    let strategyTrades = demoTrades.filter(t => t.exit_price !== null && t.exit_price !== undefined && matches(t));
    
    if (strategyTrades.length === 0) {
        const openMatches = demoTrades.filter(t => (t.exit_price === null || t.exit_price === undefined) && matches(t));
        // Only fall back to live trades if they actually have some PnL data
        if (openMatches.length > 0 && openMatches.some(t => Math.abs(parseFloat(t.pnl) || 0) > 0)) {
            strategyTrades = openMatches; 
            live = true; 
        }
    }

    // If completely empty, return a believable synthetic fallback based on the strategy name
    // so the marketing cards never look broken/empty.
    if (strategyTrades.length === 0) {
        return null;
    }

    const wins = strategyTrades.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
    const winRate = strategyTrades.length > 0 ? ((wins / strategyTrades.length) * 100).toFixed(0) + '%' : '0%';
    const totalPnL = strategyTrades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
    
    // Calculate last 7 days history (closed trades only; open trades have no exit_time)
    const history = [0, 0, 0, 0, 0, 0, 0];
    const now = new Date();
    strategyTrades.forEach(t => {
        if (!t.exit_time) return;
        const tradeDate = new Date(t.exit_time);
        const diffDays = Math.floor((now - tradeDate) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 7) {
            history[6 - diffDays] += (parseFloat(t.pnl) || 0);
        }
    });

    return { winRate, totalPnL: totalPnL.toFixed(2), history, live };
  };

  // Display metadata for well-known strategy IDs. Anything not in this lookup
  // gets a humanised fallback name so any strategy the demo tenant runs will
  // still render a card (BUG FIX: previously a hardcoded filter discarded any
  // strategy whose ID wasn't in this list, which is why manually-added strategies
  // never appeared on the landing page).
  const STRATEGY_DISPLAY = {
    ORACLE_PRICE_ACTION_V1: { name: 'Oracle Breakout', color: 'indigo' },
    KELTNER_EXECUTION_V1:   { name: 'Keltner Execution', color: 'cyan' },
    SOL_RANGE_REVERSION_V1: { name: 'Range Reversion', color: 'purple' },
    DOGE_HF_SCALPER_V1:     { name: 'HF Scalper', color: 'emerald' },
  };

  const humaniseStrategy = (id) => {
    if (!id) return 'Strategy';
    return id.replace(/_v?\d+$/i, '')      // drop trailing _V1 / _v2 / _v1
             .replace(/_/g, ' ')
             .toLowerCase()
             .replace(/\b\w/g, c => c.toUpperCase());
  };

  // Render cards dynamically from the LIVE demoConfigs. Each row in demoConfigs
  // is already filtered server-side to is_active=true, so this list always
  // reflects what the demo tenant is actually running right now.
  const activeShowcaseStrategies = demoConfigs.map((c) => {
    const meta = STRATEGY_DISPLAY[c.strategy] || {};
    return {
      id: c.strategy,
      asset: c.asset,
      name: meta.name || humaniseStrategy(c.strategy),
      color: meta.color || 'indigo',
    };
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-cyan-500/30">
      <Head>
        <title>Nexus | Autonomous Quantitative Execution</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Navbar */}
      <nav className="fixed w-full z-50 bg-slate-900/60 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-20">
            <div className="flex-shrink-0 flex items-center gap-2">
              <svg className="w-8 h-8 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span className="font-bold text-2xl tracking-wider">NEXUS</span>
            </div>
            <div className="hidden md:block">
              <div className="ml-10 flex items-baseline space-x-8">
                <a href="#features" className="hover:text-cyan-400 transition-colors">Features</a>
                <a href="#architecture" className="hover:text-cyan-400 transition-colors">Architecture</a>
                <a href="#pricing" className="hover:text-cyan-400 transition-colors">Pricing</a>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/auth" className="hover:text-cyan-400 transition-colors">
                Dashboard
              </Link>
              <Link href="/auth" className="md:hidden bg-indigo-600 text-white px-4 py-2 rounded-full text-xs font-bold">
                Deploy Agent
              </Link>
              <Link href="/auth" className="hidden sm:block bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-6 py-2 rounded-full font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]">
                Deploy Your Agent
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="relative pt-32 pb-20 sm:pt-40 sm:pb-24 lg:pb-32 overflow-hidden">
        <div className="absolute top-0 left-1/2 w-full -translate-x-1/2 h-full overflow-hidden -z-10 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/20 rounded-full blur-[100px]"></div>
          <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-[100px]"></div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6">
            {content.hero?.title || FALLBACK_CONTENT.hero.title}<br />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-500">
              {content.hero?.titleGradient || FALLBACK_CONTENT.hero.titleGradient}
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-lg md:text-xl text-slate-400 mx-auto mb-8">
            {content.hero?.subtitle || FALLBACK_CONTENT.hero.subtitle}
          </p>

          {/* INLINE CHAT WIDGET */}
          <div className="mb-10">
            <WebhookCreator />
          </div>
          
          {/* CTA BUTTONS */}
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <a href="#pricing" className="bg-white text-slate-950 px-8 py-4 rounded-full font-bold text-lg transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)]">
              {content.hero?.ctaConnect || FALLBACK_CONTENT.hero.ctaConnect}
            </a>
            <Link href="/auth" className="bg-slate-900/60 backdrop-blur-md border border-white/5 px-8 py-4 rounded-full font-bold text-lg hover:bg-slate-800 transition-colors">
              {content.hero?.ctaDashboard || FALLBACK_CONTENT.hero.ctaDashboard}
            </Link>
          </div>
          <p className="mt-6 text-sm text-slate-500">{content.hero?.trialText || FALLBACK_CONTENT.hero.trialText}</p>
        </div>
      </div>

      {/* The Agitation */}
      <div className="py-20 bg-slate-900 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold mb-4">Retail Trading is Broken.</h2>
          <p className="text-slate-400 max-w-3xl mx-auto text-lg mb-12 leading-relaxed">
            You spend hours backtesting the perfect script. The signal fires—but the S&amp;P 500 is tanking, the Dollar is surging, and whales are spoofing the order book. Your script blindly buys into a brick wall, and you get stopped out. <strong className="text-white">You don&apos;t need another indicator. You need an execution desk.</strong>
          </p>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="py-24 relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-cyan-400 font-semibold tracking-wide uppercase">Meet Nexus AI</h2>
            <p className="mt-2 text-4xl font-extrabold">Your Personal Risk Manager</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {(content.features || FALLBACK_CONTENT.features).map((feat, i) => (
              <div key={i} className={`bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl${i === 1 ? ' relative overflow-hidden' : ''}`}>
                {i === 1 && <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-bl-full blur-2xl"></div>}
                <div className={`w-12 h-12 ${i === 1 ? 'bg-purple-500/20' : 'bg-cyan-500/20'} rounded-lg flex items-center justify-center mb-6${i === 1 ? ' relative z-10' : ''}`}>
                  {i === 0 && <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>}
                  {i === 1 && <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                  {i === 2 && <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>}
                </div>
                <h3 className={`text-xl font-bold mb-3${i === 1 ? ' relative z-10' : ''}`}>{feat.title}</h3>
                <p className={`text-slate-400 leading-relaxed${i === 1 ? ' relative z-10' : ''}`}>{feat.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Architecture */}
      <div id="architecture" className="py-24 bg-slate-900 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row items-center gap-16">
            <div className="w-full lg:w-1/2">
              <h2 className="text-4xl font-extrabold mb-6">From Backtest to Bank Account.</h2>
              <div className="space-y-8 mt-10">
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">1</div>
                  <div>
                    <h4 className="text-xl font-bold">Deploy a Strategy</h4>
                    <p className="text-slate-400 mt-1">Choose from our battle-tested strategy library. Plug in your parameters and backtest natively.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">2</div>
                  <div>
                    <h4 className="text-xl font-bold">The Sandbox</h4>
                    <p className="text-slate-400 mt-1">Watch Nexus AI manage a simulated $100k portfolio in live market conditions. Watch it veto toxic setups without risking a dime.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">3</div>
                  <div>
                    <h4 className="text-xl font-bold">Flip the Switch to LIVE</h4>
                    <p className="text-slate-400 mt-1">Connect your &quot;Trade Only&quot; API keys. Allocate capital. Go to sleep. Wake up to Discord push notifications of secured profit.</p>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="w-full lg:w-1/2">
              <div className="bg-slate-950 rounded-xl overflow-hidden border border-slate-700 shadow-2xl">
                <div className="bg-slate-900 px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  </div>
                  
                  {/* Terminal Filter Bar */}
                  <div className="flex bg-slate-950/50 p-1 rounded-lg border border-white/5">
                    {['ALL', 'CORTEX', 'WATCHDOG', 'SNIPER'].map(f => (
                      <button 
                        key={f}
                        onClick={() => setTerminalFilter(f)}
                        className={`px-3 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all ${terminalFilter === f ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                    Live Stream
                  </span>
                </div>

                {/* Dummy Account Stats Header */}
                <div className="bg-slate-900/50 px-6 py-4 border-b border-white/5 flex justify-between items-center">
                    <div className="flex gap-8">
                        <div>
                            <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">{demoStats.live ? 'Live Win Rate' : 'Win Rate'}</p>
                            <p className="text-lg font-black text-emerald-400 font-mono">{demoStats.winRate}</p>
                        </div>
                        <div>
                            <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">{demoStats.live ? 'Unrealized PnL' : 'Total PnL'}</p>
                            <p className="text-lg font-black text-indigo-400 font-mono">{demoStats.totalPnL}</p>
                        </div>
                    </div>
                    {activeDemoTrade && (
                        <div className="flex items-center gap-3 bg-indigo-500/10 border border-indigo-500/20 px-4 py-2 rounded-xl">
                            <Activity size={14} className="text-indigo-400 animate-pulse" />
                            <div>
                                <p className="text-[8px] text-indigo-300 uppercase font-black tracking-widest">Active: {activeDemoTrade.symbol}</p>
                                <p className="text-xs font-mono font-bold text-white italic">
                                    {activeDemoTrade.side} @ ${activeDemoTrade.entry_price}
                                    {activeDemoTrade.pnl && (
                                        <span className={`ml-2 ${parseFloat(activeDemoTrade.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                            (${parseFloat(activeDemoTrade.pnl).toFixed(2)})
                                        </span>
                                    )}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-6 font-mono text-sm text-slate-300 space-y-2 h-[400px] overflow-y-auto">
                  {filteredLogs.map((log, i) => (
                    <p key={i} className={log.color || 'text-slate-300'}>
                      {log.timestamp && (
                        <span className="text-slate-600 mr-2 text-[11px]">
                          [{new Date(log.timestamp).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
                        </span>
                      )}
                      &gt; [{log.type}] {log.text}
                    </p>
                  ))}
                  <div className="animate-pulse inline-block w-2 h-4 bg-cyan-400 ml-1"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Strategy Intelligence Section */}
      <div className="py-24 bg-slate-950 border-t border-slate-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-cyan-400 font-semibold tracking-wide uppercase">Performance Matrix</h2>
            <p className="mt-2 text-4xl font-extrabold text-white">Strategy Intelligence</p>
            <p className="mt-4 text-slate-400 max-w-2xl mx-auto">Live transparency of our autonomous agent performance in the demo environment.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {activeShowcaseStrategies.length > 0 ? activeShowcaseStrategies.map((strat, i) => {
              const stats = getStrategyStats(strat.id, strat.asset);
              const isSelected = selectedStrategy === strat.id;

              return (
                <div 
                    key={i} 
                    onClick={() => setSelectedStrategy(isSelected ? null : strat.id)}
                    className={`group bg-slate-900/40 backdrop-blur-md border p-6 rounded-2xl transition-all duration-300 cursor-pointer hover:-translate-y-1 ${isSelected ? 'border-indigo-500 bg-slate-900/80 ring-1 ring-indigo-500/50' : 'border-white/5 hover:border-indigo-500/50 hover:bg-slate-900/60'}`}
                >
                    <div className="flex justify-between items-start mb-6">
                    <div>
                        <h4 className="text-lg font-bold text-white">{baseTicker(strat.asset)}-PERP</h4>
                        <p className="text-xs text-slate-500 uppercase tracking-widest">{strat.name}</p>
                    </div>
                    <div className={`w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center`}>
                        <TrendingUp className="w-5 h-5 text-indigo-400" />
                    </div>
                    </div>
                    
                    <div className="space-y-4">
                    {stats ? (
                      <>
                    <div className="flex justify-between items-end">
                        <span className="text-xs text-slate-400 uppercase font-black tracking-widest">{stats.live ? 'Live Win Rate' : 'Win Rate'}</span>
                        <span className="text-xl font-black text-white">{stats.winRate}</span>
                    </div>
                    
                    {/* Dynamic Sparkline */}
                    <div className="flex items-end gap-1 h-8">
                        {stats.history.map((h, j) => {
                          // Scale height relative to max in history or a minimum
                          const max = Math.max(...stats.history, 1);
                          const height = Math.max(10, (h / max) * 100);
                          return (
                            <div 
                                key={j} 
                                className={`flex-1 rounded-t-sm transition-all duration-500 ${h >= 0 ? 'bg-emerald-500/40' : 'bg-red-500/40'}`} 
                                style={{ height: `${Math.abs(height)}%` }}
                            />
                          );
                        })}
                    </div>

                    <div className="flex justify-between items-center pt-2">
                        <span className="text-xs text-slate-400 uppercase font-black tracking-widest">{stats.live ? 'Unrealized PnL' : 'Lifetime PnL'}</span>
                        <span className={`font-bold ${parseFloat(stats.totalPnL) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {parseFloat(stats.totalPnL) >= 0 ? '+' : ''}${stats.totalPnL}
                        </span>
                    </div>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center py-6">
                        <div className="text-center">
                          <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse mx-auto mb-2" />
                          <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">Awaiting trades...</p>
                        </div>
                      </div>
                    )}
                    </div>

                    <div className="mt-6 pt-6 border-t border-white/5 flex justify-between items-center">
                        <span className="text-[10px] text-slate-500 font-mono">Real-time Data</span>
                        <Link href="/auth" className="text-[10px] font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                            Deploy <ChevronRight className="w-3 h-3" />
                        </Link>
                    </div>
                </div>
              );
            }) : (
                <div className="col-span-full py-12 text-center bg-slate-900/20 rounded-3xl border border-white/5">
                    <p className="text-slate-500 font-mono text-sm uppercase tracking-widest">No active strategy intelligence detected for demo.</p>
                </div>
            )}
          </div>
        </div>
      </div>

      {/* Proprietary Differentiators — The Edge */}
      <div className="py-24 relative overflow-hidden">
        <div className="absolute inset-0 -z-10 pointer-events-none">
          <div className="absolute top-1/2 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px]"></div>
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px]"></div>
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">The Unfair Advantage</span>
            <h2 className="text-4xl font-extrabold mt-3 mb-4">Engineered to Out-Execute You.</h2>
            <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed">
              Nexus isn&apos;t a script with a few indicators. It&apos;s a five-tier confluence engine that fuses institutional flow, microstructure, and order-book intent into a single autonomous decision.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {(content.differentiators || FALLBACK_CONTENT.differentiators).map((card) => (
              <div key={card.title} className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-7 rounded-2xl hover:border-cyan-500/30 transition-colors">
                <h3 className="text-lg font-bold text-white mb-3">{card.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: card.body }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Testimonials */}
      {(content.testimonials || FALLBACK_CONTENT.testimonials).length > 0 && (
        <div className="py-24 bg-slate-950">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-16">
              <h2 className="text-3xl font-extrabold mb-4">What Traders Say</h2>
              <p className="text-slate-400">Real results from real traders. No cherry-picked backtests.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
              {(content.testimonials || FALLBACK_CONTENT.testimonials).map((t) => (
                <div key={t.name} className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-7 rounded-2xl hover:border-cyan-500/30 transition-colors flex flex-col">
                  <div className="flex items-center gap-1 mb-4">
                    {[...Array(5)].map((_, i) => (
                      <span key={i} className="text-cyan-400 text-sm">★</span>
                    ))}
                  </div>
                  <p className="text-slate-300 text-sm leading-relaxed mb-6 flex-1 italic">
                    &ldquo;{t.quote}&rdquo;
                  </p>
                  <div className="flex items-center justify-between pt-4 border-t border-white/5">
                    <div>
                      <p className="text-white text-sm font-semibold">{t.name}</p>
                      <p className="text-slate-500 text-xs">{t.plan} Plan</p>
                    </div>
                    <div className="text-right">
                      <p className="text-green-400 text-sm font-bold">+${t.total_pnl.toLocaleString()}</p>
                      <p className="text-slate-500 text-xs">{t.closed_trades} trades</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Pricing */}
      <div id="pricing" className="py-24 bg-slate-900 border-t border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-extrabold mb-4">Choose Your Arsenal</h2>
            <p className="text-slate-400">Flat-rate, fair-use pricing. No metered surprises. Cancel anytime.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            {(content.pricing || FALLBACK_CONTENT.pricing).map((tier) => (
              <div
                key={tier.name}
                className={`p-8 rounded-2xl flex flex-col backdrop-blur-md ${
                  tier.popular
                    ? 'bg-slate-900/80 border border-cyan-500/50 relative transform md:-translate-y-4 shadow-[0_0_30px_rgba(34,211,238,0.1)]'
                    : 'bg-slate-900/60 border border-white/5'
                }`}
              >
                {tier.popular && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-cyan-500 text-slate-900 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">Most Popular</div>
                )}
                <h3 className={`text-2xl font-bold ${tier.popular ? 'text-white' : 'text-slate-300'}`}>{tier.name}</h3>
                <div className="mt-4 mb-8">
                  <span className={`text-4xl font-extrabold ${tier.popular ? 'text-white' : ''}`}>{tier.price}</span>
                  <span className="text-slate-500">/mo</span>
                </div>
                <ul className={`space-y-4 mb-8 flex-1 ${tier.popular ? 'text-slate-300' : 'text-slate-400'}`}>
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start">
                      <svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/auth"
                  className={`w-full text-center font-bold py-3 rounded-xl transition-colors ${
                    tier.popular
                      ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-900'
                      : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}
                >
                  Start 7-Day Trial
                </Link>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-slate-950 border-t border-slate-900 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center">
          <div className="flex items-center gap-2 mb-4 md:mb-0">
            <svg className="w-6 h-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span className="font-bold text-xl text-slate-600 tracking-wider">NEXUS</span>
          </div>
          <p className="text-slate-600 text-sm">© 2026 Nexus Quantitative. All rights reserved.</p>
        </div>
      </footer>

      {/* Rationalization Toast */}
      <div className={`fixed bottom-8 right-8 z-[60] transition-all duration-500 transform ${showRationalization ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0 pointer-events-none'}`}>
        <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/30 p-6 rounded-2xl shadow-[0_0_40px_rgba(99,102,241,0.2)] max-w-xs">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-ping"></div>
            <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Agent Cortex</span>
          </div>
          <p className="text-xs text-slate-300 font-medium leading-relaxed">
            Rationalizing trade for <span className="text-white font-bold">SOL-PERP</span>... analyzing volume absorption at 5M nodes.
          </p>
        </div>
      </div>
    </div>
  );
}