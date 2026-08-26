// hard push tf

import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { Activity, ChevronRight, TrendingUp, ExternalLink, Crosshair, ChevronDown, ChevronUp } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import WebhookCreator from '../components/WebhookCreator';
import { fetchSiteContent, FALLBACK_CONTENT } from '../lib/site-content';
import { trackEvent } from '../lib/analytics';
import QuickSignupPopup from '../components/QuickSignupPopup';

const supabaseReadOnly = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

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
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showSignupPopup, setShowSignupPopup] = useState(false);
  const [executionMode, setExecutionMode] = useState('ALL');
  const [dateFilter, setDateFilter] = useState('30d');
  const [expandedTrade, setExpandedTrade] = useState(null);
  // 🧠 Linked core memories (influencing + generated) keyed by memory id, fetched via /api/demo-feed
  const [linkedMemories, setLinkedMemories] = useState({});
  // Per-trade expand toggles for the two (separated) core memory groups
  const [expandedMemories, setExpandedMemories] = useState({});
  const [toolCallsMap, setToolCallsMap] = useState({});
  const [expandedToolCalls, setExpandedToolCalls] = useState({});

  useEffect(() => {
    fetchSiteContent(supabaseReadOnly).then(setContent);
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
        // Build linked memories map from feed response
        if (data.memories?.length) {
          const map = {};
          data.memories.forEach(m => { map[m.id] = m; });
          setLinkedMemories(map);
        }
        // Trades drive stats. Always recompute against the latest payload so the
        // win rate and PnL reflect what the demo tenant is actually doing.
        const trades = data.trades || [];
        setDemoTrades(trades);

        // Build tool calls map from feed response using time-window matching
        if (data.toolCalls?.length) {
          const tcMap = {};
          data.toolCalls.forEach(tc => {
            const tcTime = new Date(tc.created_at).getTime();
            const matchingTrade = trades.find(tr => {
              const trTime = new Date(tr.created_at).getTime();
              const diff = trTime - tcTime;
              return diff >= 0 && diff < 120000;
            });
            if (matchingTrade) {
              if (!tcMap[matchingTrade.id]) tcMap[matchingTrade.id] = [];
              const list = tcMap[matchingTrade.id];
              const insertIdx = list.findIndex(existing => new Date(tc.created_at) < new Date(existing.created_at));
              if (insertIdx === -1) list.push(tc); else list.splice(insertIdx, 0, tc);
            }
          });
          setToolCallsMap(tcMap);
        }
        // Configs are pre-filtered to is_active=true by /api/demo-feed.
        setDemoConfigs(data.configs || []);
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

  // Helper to normalize execution mode across variants (e.g. 'LIVE', 'LIVE (EXCHANGE)', 'PAPER')
  const getTradeMode = (t) => {
    const raw = (t?.execution_mode || 'PAPER').toString().toUpperCase().trim();
    if (raw.includes('LIVE')) return 'LIVE';
    if (raw.includes('PAPER')) return 'PAPER';
    return raw;
  };

  // Date filtering prioritizes closed trade exit_time, falling back to entry created_at
  const now = new Date();
  const dateFiltered = dateFilter === 'all' ? demoTrades
    : demoTrades.filter(t => {
        const rawDate = t.exit_time || t.created_at;
        if (!rawDate) return false;
        const d = new Date(rawDate);
        if (isNaN(d.getTime())) return false;
        const diff = (now - d) / (1000 * 60 * 60 * 24);
        if (dateFilter === 'today') return diff <= 1;
        if (dateFilter === '7d') return diff <= 7;
        if (dateFilter === '30d') return diff <= 30;
        return true;
      });

  const filteredTrades = executionMode === 'ALL'
    ? dateFiltered
    : dateFiltered.filter(t => getTradeMode(t) === executionMode);

  // Client-side sort: newest first by created_at, regardless of filter.
  const sortedFilteredTrades = [...filteredTrades].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  const modeStats = (() => {
    const all = sortedFilteredTrades;
    const closed = all.filter(t => t.exit_price !== null && t.exit_price !== undefined);
    const open = all.filter(t => t.exit_price === null || t.exit_price === undefined);
    if (closed.length > 0) {
      const wins = closed.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
      return { winRate: ((wins / closed.length) * 100).toFixed(1) + '%', totalTrades: closed.length, totalPnL: `$${closed.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0).toFixed(2)}`, mode: executionMode };
    }
    if (open.length > 0) {
      const greens = open.filter(t => (parseFloat(t.current_roe ?? t.pnl) || 0) > 0).length;
      return { winRate: ((greens / open.length) * 100).toFixed(1) + '%', totalTrades: open.length, totalPnL: `$${open.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0).toFixed(2)}`, mode: executionMode };
    }
    return { winRate: '0%', totalTrades: 0, totalPnL: '$0.00', mode: executionMode };
  })();

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

  const handlePlanSelect = (tier) => {
    trackEvent('plan_selected', { tier, method: 'pricing_card' });
    setSelectedPlan(tier);
    setShowSignupPopup(true);
  };

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
                <a href="#trades" className="hover:text-cyan-400 transition-colors">Trade Log</a>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <a href="#pricing" className="hover:text-cyan-400 transition-colors">
                Dashboard
              </a>
              <a href="#pricing" className="md:hidden bg-indigo-600 text-white px-4 py-2 rounded-full text-xs font-bold">
                Deploy Agent
              </a>
              <a href="#pricing" className="hidden sm:block bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-6 py-2 rounded-full font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]">
                Deploy Your Agent
              </a>
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
            <a href="#pricing" className="bg-slate-900/60 backdrop-blur-md border border-white/5 px-8 py-4 rounded-full font-bold text-lg hover:bg-slate-800 transition-colors">
              {content.hero?.ctaDashboard || FALLBACK_CONTENT.hero.ctaDashboard}
            </a>
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
                <div className="bg-slate-900/50 px-6 py-4 border-b border-white/5 flex flex-wrap justify-between items-center gap-4">
                    {/* Execution Mode Toggle */}
                    <div className="flex items-center bg-slate-950/70 p-1 rounded-lg border border-white/5">
                        <button
                            type="button"
                            onClick={() => setExecutionMode('ALL')}
                            className={`px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
                                executionMode === 'ALL'
                                    ? 'bg-indigo-600 text-white shadow-lg'
                                    : 'text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            ALL
                        </button>
                        <button
                            type="button"
                            onClick={() => setExecutionMode('LIVE')}
                            className={`relative px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
                                executionMode === 'LIVE'
                                    ? 'bg-emerald-500/20 text-emerald-400 shadow-[inset_0_0_10px_rgba(52,211,153,0.15)]'
                                    : 'text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            <span className="flex items-center gap-1.5">
                                LIVE
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${executionMode === 'LIVE' ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-600/50'}`} />
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setExecutionMode('PAPER')}
                            className={`px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
                                executionMode === 'PAPER'
                                    ? 'bg-amber-500/20 text-amber-400 shadow-[inset_0_0_10px_rgba(251,191,36,0.15)]'
                                    : 'text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            PAPER
                        </button>
                    </div>

                    <div className="flex gap-6 items-center">
                        {modeStats ? (
                            <>
                                <div>
                                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">Win Rate</p>
                                    <p className="text-lg font-black text-emerald-400 font-mono">{modeStats.winRate}</p>
                                </div>
                                <div>
                                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">PnL</p>
                                    <p className="text-lg font-black text-indigo-400 font-mono">{modeStats.totalPnL}</p>
                                </div>
                                <div>
                                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">Closed Trades</p>
                                    <p className="text-lg font-black text-white font-mono">{modeStats.totalTrades}</p>
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">{demoStats.live ? 'Live Win Rate' : 'Win Rate'}</p>
                                    <p className="text-lg font-black text-emerald-400 font-mono">{demoStats.winRate}</p>
                                </div>
                                <div>
                                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">{demoStats.live ? 'Unrealized PnL' : 'Total PnL'}</p>
                                    <p className="text-lg font-black text-indigo-400 font-mono">{demoStats.totalPnL}</p>
                                </div>
                            </>
                        )}
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
                        <a href="#pricing" className="text-[10px] font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                            Deploy <ChevronRight className="w-3 h-3" />
                        </a>
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

      {/* 🆕 Trade Log — Public Track Record */}
      <div id="trades" className="py-24 bg-slate-900 border-y border-slate-800 overflow-x-hidden">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-cyan-400 font-semibold tracking-wide uppercase">Live Track Record</h2>
            <p className="mt-2 text-4xl font-extrabold text-white">Trade Execution Log</p>
            <p className="mt-4 text-slate-400 max-w-2xl mx-auto">
              Every trade our autonomous agents execute — open, closed, approved, or vetoed. Click any row to see the AI&apos;s reasoning.
            </p>
          </div>

          {/* Mode filter toggle */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
            <div className="flex items-center bg-slate-950/70 p-1 rounded-xl border border-white/5 flex-wrap justify-center">
              <button
                type="button"
                onClick={() => setExecutionMode('ALL')}
                className={`px-2 sm:px-4 py-1.5 rounded-lg text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${
                  executionMode === 'ALL'
                    ? 'bg-indigo-600 text-white shadow-lg'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                ALL
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('LIVE')}
                className={`relative px-2 sm:px-4 py-1.5 rounded-lg text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${
                  executionMode === 'LIVE'
                    ? 'bg-emerald-500/20 text-emerald-400 shadow-[inset_0_0_10px_rgba(52,211,153,0.15)]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  LIVE
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${executionMode === 'LIVE' ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-600/50'}`} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('PAPER')}
                className={`px-2 sm:px-4 py-1.5 rounded-lg text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${
                  executionMode === 'PAPER'
                    ? 'bg-amber-500/20 text-amber-400 shadow-[inset_0_0_10px_rgba(251,191,36,0.15)]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                PAPER
              </button>
            </div>

            {/* 🆕 Date filter */}
            <div className="inline-flex bg-slate-950/70 p-1 rounded-xl border border-white/5 flex-wrap justify-center">
              {[
                { key: 'today', label: 'Today' },
                { key: '7d', label: '7 Days' },
                { key: '30d', label: '30 Days' },
              ].map(d => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDateFilter(d.key)}
                  className={`px-2 sm:px-4 py-1.5 rounded-lg text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${
                    dateFilter === d.key
                      ? 'bg-indigo-600 text-white shadow-lg'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* Summary bar showing filtered stats */}
          {modeStats && (
            <div className="max-w-3xl mx-auto mb-10 bg-slate-950/50 border border-white/5 rounded-2xl p-4 sm:p-6 flex flex-wrap justify-center gap-3 sm:gap-6 items-center">
              <div className="text-center min-w-0 flex-1 sm:flex-none">
                <p className="text-[8px] sm:text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Win Rate</p>
                <p className="text-lg sm:text-2xl font-black text-emerald-400 font-mono">{modeStats.winRate}</p>
              </div>
              <div className="h-8 w-px bg-white/5 hidden sm:block" />
              <div className="text-center min-w-0 flex-1 sm:flex-none">
                <p className="text-[8px] sm:text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Total PnL</p>
                <p className="text-lg sm:text-2xl font-black text-indigo-400 font-mono truncate max-w-[120px] sm:max-w-none">{modeStats.totalPnL}</p>
              </div>
              <div className="h-8 w-px bg-white/5 hidden sm:block" />
              <div className="text-center min-w-0 flex-1 sm:flex-none">
                <p className="text-[8px] sm:text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Total Trades</p>
                <p className="text-lg sm:text-2xl font-black text-white font-mono">{modeStats.totalTrades}</p>
              </div>
            </div>
          )}

          {/* Trade list */}
          {sortedFilteredTrades.length > 0 ? (
            <div className="max-h-[400px] sm:max-h-[600px] overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
              {sortedFilteredTrades.slice(0, 50).map((trade, i) => {
                const isOpen = trade.exit_price === null || trade.exit_price === undefined;
                const pnlVal = parseFloat(trade.pnl) || 0;
                const isWin = !isOpen && pnlVal > 0;
                const isLoss = !isOpen && pnlVal <= 0;
                const mode = getTradeMode(trade);
                const isExpanded = expandedTrade === i;
                const reasonText = trade.reason || trade.working_thesis;

                let rowBorderBg = 'border-slate-800 bg-slate-950/40';
                if (isOpen) rowBorderBg = 'border-indigo-500/30 bg-indigo-500/5';
                else if (isWin) rowBorderBg = 'border-emerald-500/20 bg-slate-950/40';
                else if (isLoss) rowBorderBg = 'border-red-500/20 bg-slate-950/40';

                return (
                  <div
                    key={i}
                    onClick={() => setExpandedTrade(isExpanded ? null : i)}
                    className={`border rounded-2xl p-4 sm:p-5 transition-all duration-200 cursor-pointer hover:border-slate-700 ${rowBorderBg}`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      {/* Left: mode badge + asset + side + strategy */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded tracking-wider ${
                          mode === 'LIVE'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        }`}>
                          {mode}
                        </span>

                        <span className="font-bold text-white text-base font-mono">
                          {baseTicker(trade.symbol)}-PERP
                        </span>

                        <span className={`text-xs font-black uppercase px-2 py-0.5 rounded tracking-wide ${
                          String(trade.side).toUpperCase() === 'BUY' || String(trade.side).toUpperCase() === 'LONG'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-red-500/10 text-red-400'
                        }`}>
                          {trade.side}
                        </span>

                        <span className="text-xs text-slate-500 font-mono hidden md:inline">
                          {humaniseStrategy(trade.strategy_id)}
                        </span>
                      </div>

                      {/* Right: prices, PnL, open/closed, chevron */}
                      <div className="flex items-center gap-2 sm:gap-4 justify-between sm:justify-end flex-wrap">
                        <div className="text-right font-mono text-[10px] sm:text-xs text-slate-400 min-w-0">
                          <span className="truncate inline-block max-w-[70px] sm:max-w-none align-bottom">${trade.entry_price || '—'}</span>
                          <span className="mx-1 text-slate-600">→</span>
                          <span className="truncate inline-block max-w-[70px] sm:max-w-none align-bottom">{trade.exit_price ? `$${trade.exit_price}` : 'OPEN'}</span>
                        </div>

                        <div className="text-right min-w-[60px] sm:min-w-[80px]">
                          <span className={`text-xs sm:text-sm font-bold font-mono ${
                            pnlVal > 0 ? 'text-emerald-400' : (pnlVal < 0 ? 'text-red-400' : 'text-slate-300')
                          }`}>
                            {pnlVal > 0 ? '+' : ''}${pnlVal.toFixed(2)}
                          </span>
                        </div>

                        <div className="flex items-center gap-1 sm:gap-2">
                          <span className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider px-1.5 sm:px-2 py-0.5 rounded ${
                            isOpen
                              ? 'bg-indigo-500/20 text-indigo-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}>
                            {isOpen ? 'OPEN' : 'CLOSED'}
                          </span>
                          <ChevronRight className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
                        </div>
                      </div>
                    </div>

                    {/* Expandable Reasoning Panel */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t border-slate-800/80 bg-indigo-950/20 -mx-3 -mb-3 sm:-mx-4 sm:-mb-4 p-3 sm:p-4 rounded-b-2xl overflow-x-hidden">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                          <span className="text-[10px] font-mono uppercase tracking-widest text-indigo-300">Agent Reasoning &amp; Working Thesis</span>
                        </div>
                        <p className="text-xs text-slate-300 font-mono leading-relaxed whitespace-pre-wrap break-words">
                          {reasonText || 'No rationalization notes recorded for this trade.'}
                        </p>

                        {/* 🧠 Core Memory (Influenced This Trade) */}
                        {(() => {
                          const forwardMems = (trade.influencing_memory_ids || [])
                            .map(id => linkedMemories[id] || Object.values(linkedMemories).find(m => String(m.id) === String(id)))
                            .filter(Boolean);
                          if (forwardMems.length === 0) return null;
                          const memExpanded = expandedMemories[`${trade.id}-influenced`];
                          return (
                            <div className="mt-4 border-l-2 border-indigo-500/30 pl-4">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-indigo-400 flex items-center gap-2">
                                  🧠 Core Memory (Influenced This Trade)
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setExpandedMemories(prev => ({ ...prev, [`${trade.id}-influenced`]: !prev[`${trade.id}-influenced`] })); }}
                                  className="text-[9px] font-black uppercase tracking-widest text-indigo-300 hover:text-indigo-200 flex items-center gap-1 cursor-pointer"
                                >
                                  {memExpanded ? <>Collapse ▲</> : <>View {forwardMems.length} <ChevronRight className="w-3 h-3" /></>}
                                </button>
                              </div>
                              {memExpanded && (
                                <div className="space-y-2">
                                  {forwardMems.map(m => (
                                    <div key={m.id} className="bg-black/30 rounded-xl p-3 border border-indigo-500/10">
                                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${m.win_loss === 'WIN' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{m.win_loss}</span>
                                        {m.regime_at_close && <span className="text-[8px] font-mono text-slate-500 uppercase">{m.regime_at_close}</span>}
                                        {m.pnl !== null && m.pnl !== undefined && <span className={`text-[9px] font-mono ${parseFloat(m.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${parseFloat(m.pnl).toFixed(4)}</span>}
                                        {m.thesis_accurate !== null && m.thesis_accurate !== undefined && <span className={`text-[8px] font-mono ${m.thesis_accurate ? 'text-emerald-400' : 'text-red-400'}`}>{m.thesis_accurate ? '✓ Accurate' : '✗ Inaccurate'}</span>}
                                      </div>
                                      <p className="text-[11px] text-slate-400 italic leading-relaxed line-clamp-3">{m.lesson_learned}</p>
                                      {m.working_thesis && (
                                        <p className="text-[9px] text-slate-500 mt-1.5 pt-1.5 border-t border-indigo-500/10 leading-relaxed">
                                          <span className="font-black uppercase tracking-widest text-indigo-400">Thesis:</span> {m.working_thesis}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 🧠 Core Memory (Generated By This Trade) */}
                        {(() => {
                          const generatedMem = Object.values(linkedMemories)
                            .filter(m => m.trade_log_id && String(m.trade_log_id) === String(trade.id));
                          if (generatedMem.length === 0) return null;
                          const memExpanded = expandedMemories[`${trade.id}-generated`];
                          return (
                            <div className="mt-4 border-l-2 border-emerald-500/30 pl-4">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                                  🧠 Core Memory (Generated By This Trade)
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setExpandedMemories(prev => ({ ...prev, [`${trade.id}-generated`]: !prev[`${trade.id}-generated`] })); }}
                                  className="text-[9px] font-black uppercase tracking-widest text-emerald-300 hover:text-emerald-200 flex items-center gap-1 cursor-pointer"
                                >
                                  {memExpanded ? <>Collapse ▲</> : <>View {generatedMem.length} <ChevronRight className="w-3 h-3" /></>}
                                </button>
                              </div>
                              {memExpanded && (
                                <div className="space-y-2">
                                  {generatedMem.map(m => (
                                    <div key={m.id} className="bg-black/30 rounded-xl p-3 border border-emerald-500/10">
                                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${m.win_loss === 'WIN' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{m.win_loss}</span>
                                        {m.regime_at_close && <span className="text-[8px] font-mono text-slate-500 uppercase">{m.regime_at_close}</span>}
                                        {m.pnl !== null && m.pnl !== undefined && <span className={`text-[9px] font-mono ${parseFloat(m.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>${parseFloat(m.pnl).toFixed(4)}</span>}
                                        {m.thesis_accurate !== null && m.thesis_accurate !== undefined && <span className={`text-[8px] font-mono ${m.thesis_accurate ? 'text-emerald-400' : 'text-red-400'}`}>{m.thesis_accurate ? '✓ Accurate' : '✗ Inaccurate'}</span>}
                                      </div>
                                      <p className="text-[11px] text-slate-400 italic leading-relaxed line-clamp-3">{m.lesson_learned}</p>
                                      {m.working_thesis && (
                                        <p className="text-[9px] text-slate-500 mt-1.5 pt-1.5 border-t border-emerald-500/10 leading-relaxed">
                                          <span className="font-black uppercase tracking-widest text-emerald-400">Thesis:</span> {m.working_thesis}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 🛠️ Agent Tool Calls */}
                        {(() => {
                          const toolCalls = toolCallsMap[trade.id] || [];
                          if (toolCalls.length === 0) return null;
                          const tcExpanded = expandedToolCalls[trade.id];
                          return (
                            <div className="mt-4 border-l-2 border-amber-500/30 pl-4 py-1">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2">
                                  <Crosshair size={12}/> Agent Tool Calls ({toolCalls.length})
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setExpandedToolCalls(prev => ({ ...prev, [trade.id]: !prev[trade.id] })); }}
                                  className="text-[9px] font-black uppercase tracking-widest text-amber-300 hover:text-amber-200 flex items-center gap-1 cursor-pointer"
                                >
                                  {tcExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {toolCalls.length} <ChevronDown size={10}/></>}
                                </button>
                              </div>
                              {tcExpanded && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden max-h-[200px] overflow-y-auto">
                                  <table className="w-full text-[10px] font-mono">
                                    <thead>
                                      <tr className="border-b border-white/5 text-[8px] uppercase tracking-widest text-slate-500">
                                        <th className="px-3 py-2 text-left">Tool</th>
                                        <th className="px-3 py-2 text-right">Duration</th>
                                        <th className="px-3 py-2 text-right">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {toolCalls.map(tc => (
                                        <tr key={tc.id || tc.tool_name + tc.created_at} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                                          <td className="px-3 py-2 text-slate-300">{tc.tool_name.replace('coinglass_', 'cg_')}</td>
                                          <td className="px-3 py-2 text-right text-slate-400">{tc.duration_ms}ms</td>
                                          <td className="px-3 py-2 text-right">
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                                              tc.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                            }`}>
                                              {tc.status === 'success' ? 'OK' : 'ERR'}
                                            </span>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {toolCalls.some(tc => tc.response_summary) && (
                                    <div className="p-3 border-t border-white/5 bg-black/30">
                                      <p className="text-[8px] uppercase tracking-widest text-slate-500 mb-1">Response:</p>
                                      <pre className="text-[9px] text-slate-400 whitespace-pre-wrap break-all leading-relaxed">
                                        {toolCalls.map(tc => `[${tc.tool_name}] ${tc.response_summary || ''}`).join('\n').substring(0, 500)}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center bg-slate-950/30 rounded-3xl border border-white/5">
              <p className="text-slate-500 font-mono text-sm uppercase tracking-widest">
                {executionMode === 'ALL'
                  ? 'No trades recorded yet.'
                  : `No ${executionMode} trades recorded yet.`}
              </p>
            </div>
          )}

          {/* Public URL hint */}
          <div className="mt-8 text-center flex items-center justify-center gap-2 text-xs text-slate-500">
            <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
            <span>This page is public — share this URL directly for full trade transparency.</span>
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
                <button
                  onClick={() => handlePlanSelect(tier.name.toUpperCase())}
                  className={`w-full text-center font-bold py-3 rounded-xl transition-colors cursor-pointer ${
                    tier.popular
                      ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-900'
                      : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}
                >
                  Start 7-Day Trial
                </button>
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

      {showSignupPopup && (
        <QuickSignupPopup
          plan={selectedPlan}
          onClose={() => setShowSignupPopup(false)}
        />
      )}
    </div>
  );
}