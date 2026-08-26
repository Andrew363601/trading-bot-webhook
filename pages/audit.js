import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Filter, RefreshCw, CheckCircle2, Zap, BrainCircuit, Server, Crosshair, Target, Loader2, Clock, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { createPagesServerClient } from '@supabase/auth-helpers-nextjs';

function ThesisDisplay({ reasoning, isVeto, score }) {
  const [expanded, setExpanded] = useState(false);
  
  if (!reasoning) return null;
  
  const isLong = reasoning.length > 250;
  const content = (isLong && !expanded) ? reasoning.slice(0, 250) + '...' : reasoning;

  return (
    <div className={`border-l-2 pl-4 py-1 ${isVeto ? 'border-red-500/30' : 'border-amber-500/30'}`}>
       <h4 className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mb-2 ${isVeto ? 'text-red-400' : 'text-amber-400'}`}>
          <BrainCircuit size={12}/> Oracle Analysis {score && `(Score: ${score})`}
       </h4>
       <div className="bg-black/20 p-3 rounded-xl border border-white/5 relative">
         <p className="text-[12px] text-slate-400 leading-relaxed italic whitespace-pre-wrap">
            &quot;{content}&quot;
         </p>
         {isLong && (
           <button 
             onClick={() => setExpanded(!expanded)}
             className="text-[10px] text-amber-500 hover:text-amber-400 mt-2 font-bold uppercase tracking-widest flex items-center gap-1 transition-colors"
           >
             {expanded ? 'Show Less' : 'Show More'}
           </button>
         )}
       </div>
    </div>
  );
}

export default function AuditLog({ initialSession }) {
  const session = useSession() || initialSession;
  
  if (!session) {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 md:p-6 font-sans flex flex-col gap-6 max-w-[100vw] overflow-x-hidden">
      <AuditLogContent />
    </div>
  );
}

export async function getServerSideProps(context) {
  const supabase = createPagesServerClient(context);
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    return { redirect: { destination: '/auth', permanent: false } };
  }

  return { props: { initialSession: session } };
}

function AuditLogContent() {
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState(null); // 🟢 Security: Tenant Isolation
  const [reviewingId, setReviewingId] = useState(null); 
  const [closingId, setClosingId] = useState(null); // 🟢 THE FIX: Tracks which trade is being canceled
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  // 🟢 Tracks expanded core memories per trade
  const [expandedMemories, setExpandedMemories] = useState({});
  // 🟢 Cache of core memories keyed by memory ID and trade_log_id
  const [linkedMemories, setLinkedMemories] = useState({});
  // 🟢 Shadow Portfolio records for VETO outcome evaluation
  const [shadowRecords, setShadowRecords] = useState([]);
  const [riskBlocks, setRiskBlocks] = useState([]);
  const [showRiskBlocks, setShowRiskBlocks] = useState(false);
  const [toolCalls, setToolCalls] = useState([]);
  const supabase = useSupabaseClient();
  const session = useSession();

  // Load tenant_id on mount
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
        if (users?.tenant_id) setTenantId(users.tenant_id);
      } catch (err) {
        console.error('Failed to load tenant_id:', err);
      }
    };
    loadTenantId();
  }, [session, supabase]);
  
  const [liveState, setLiveState] = useState({ scanning: false, oracle: false, executing: false, resting: false, progress: 0 });

  const fetchAuditTrail = useCallback(async () => {
    if (!tenantId) return; // Wait for tenant_id
    setLoading(true);
    try {
      const [{ data: scans }, { data: trades }] = await Promise.all([
        supabase.from('scan_results').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(200),
        supabase.from('trade_logs').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(200)
      ]);

      const now = Date.now();
      const latestScan = scans?.[0];
      const latestTrade = trades?.[0];
      
      // Calculate live state based on most recent activity for the current filter
      const relevantScans = assetFilter === 'ALL' ? (scans || []) : (scans || []).filter(s => s.asset === assetFilter);
      const relevantTrades = assetFilter === 'ALL' ? (trades || []) : (trades || []).filter(t => t.symbol === assetFilter);
      
      const topScan = relevantScans[0];
      const topTrade = relevantTrades[0];

      const scanAge = topScan ? now - new Date(topScan.created_at).getTime() : Infinity;
      const tradeAge = topTrade ? now - new Date(topTrade.created_at).getTime() : Infinity;

      let progress = 0;
      if (scanAge < 45000) progress = 25;
      if (scanAge < 45000 && topScan?.status === 'RESONANT') progress = 50;
      if (tradeAge < 90000 && !topTrade?.exit_price) progress = 75;
      if (tradeAge < 90000 && topTrade?.tp_price && !topTrade?.exit_price) progress = 100;

      setLiveState({
        scanning: scanAge < 45000, 
        oracle: scanAge < 45000 && topScan?.status === 'RESONANT',
        executing: tradeAge < 90000 && topTrade?.exit_price === null, 
        resting: tradeAge < 90000 && topTrade?.exit_price === null && topTrade?.tp_price,
        progress
      });

      const groupedPipelines = [];
      const usedScans = new Set();

      (trades || []).forEach(trade => {
        const tradeTime = new Date(trade.created_at).getTime();
        const relatedScan = (scans || []).find(s => {
          if (usedScans.has(s.id)) return false;
          const timeDiff = tradeTime - new Date(s.created_at).getTime();
          return s.asset === trade.symbol && s.strategy === trade.strategy_id && timeDiff >= 0 && timeDiff < 3600000;
        });

        if (relatedScan) usedScans.add(relatedScan.id);
        groupedPipelines.push({ type: 'FULL_TRADE', asset: trade.symbol, strategy: trade.strategy_id, timestamp: tradeTime, trade: trade, scan: relatedScan || null });
      });

      (scans || []).forEach(scan => {
        if (!usedScans.has(scan.id)) {
          groupedPipelines.push({ type: 'ORPHAN_SCAN', asset: scan.asset, strategy: scan.strategy, timestamp: new Date(scan.created_at).getTime(), scan: scan, trade: null });
        }
      });

      groupedPipelines.sort((a, b) => b.timestamp - a.timestamp);
      setPipelines(groupedPipelines);

      // 🟢 Shadow Portfolio: fetch VETO labels
      try {
        const { data: shadows } = await supabase
          .from('shadow_portfolio')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(100);
        if (shadows) setShadowRecords(shadows);
      } catch (e) {
        console.error('[AUDIT] Shadow portfolio fetch failed:', e.message);
      }

      // 🟢 Agent Tool Calls: fetch tool call audit data
      let toolCallsData = [];
      try {
        const { data } = await supabase
          .from('agent_tool_calls')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(500);
        if (data) {
          toolCallsData = data;
          setToolCalls(data);
        }
      } catch (e) {
        console.error('[AUDIT] Tool calls fetch failed:', e.message);
      }

      // 🟢 Match tool calls to pipeline entries by time window
      const toolCallMap = new Map();
      (toolCallsData || []).forEach(tc => {
        const tcTime = new Date(tc.created_at).getTime();
        const match = groupedPipelines.find(p => {
          const diff = p.timestamp - tcTime;
          return diff >= 0 && diff < 120000; // 2 min window before the pipeline event
        });
        if (match) {
          const key = match.timestamp + '-' + (match.trade?.id || match.scan?.id || '');
          if (!toolCallMap.has(key)) toolCallMap.set(key, []);
          const calls = toolCallMap.get(key);
          // Insert sorted by time ascending
          const insertIdx = calls.findIndex(existing => new Date(tc.created_at) < new Date(existing.created_at));
          if (insertIdx === -1) calls.push(tc); else calls.splice(insertIdx, 0, tc);
        }
      });

      // Attach tool calls to pipeline entries
      groupedPipelines.forEach(p => {
        const key = p.timestamp + '-' + (p.trade?.id || p.scan?.id || '');
        p.toolCalls = toolCallMap.get(key) || [];
      });

      // 🆕 Fetch risk veto blocks
      try {
        const { data: riskData } = await supabase
          .from('risk_veto_log')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(100);
        if (riskData) setRiskBlocks(riskData);
      } catch (e) {
        console.error('[AUDIT] Risk veto log fetch failed:', e.message);
      }

      // 🟢 Fetch linked core memories for all trades in this batch
      const map = {};
      const allMemoryIds = new Set();
      const allTradeIds = new Set();
      (trades || []).forEach(t => {
        if (t.id) allTradeIds.add(t.id);
        if (t.influencing_memory_ids?.length) {
          t.influencing_memory_ids.forEach(id => allMemoryIds.add(id));
        }
      });
      if (allMemoryIds.size > 0) {
        const ids = [...allMemoryIds];
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const { data } = await supabase.from('hermes_core_memory').select('*').in('id', chunk).limit(50);
          if (data) data.forEach(m => { map[m.id] = m; });
        }
      }
      if (allTradeIds.size > 0) {
        const ids = [...allTradeIds];
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const { data } = await supabase.from('hermes_core_memory').select('*').in('trade_log_id', chunk).limit(50);
          if (data) data.forEach(m => { map[m.id] = m; });
        }
      }
      setLinkedMemories(map);
    } catch (err) { console.error("[AUDIT FAULT]:", err); } finally { setLoading(false); }
  }, [supabase, tenantId, assetFilter]);

  useEffect(() => {
    if (!tenantId) return;
    fetchAuditTrail();
    const interval = setInterval(fetchAuditTrail, 10000); 
    return () => clearInterval(interval);
  }, [fetchAuditTrail, tenantId]);

  const handleForceReview = async (tradeId) => {
      if (!session?.access_token) return;
      setReviewingId(tradeId);
      try {
          const res = await fetch('/api/reevaluate-trade', {
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
              }, 
              body: JSON.stringify({ trade_id: tradeId })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          
          alert(`Oracle Verdict: ${data.status}\n\n${data.reasoning}`);
          fetchAuditTrail(); 
      } catch (err) {
          alert(`Review Failed: ${err.message}`);
      } finally {
          setReviewingId(null);
      }
  };

  // 🟢 THE FIX: The Universal Kill Switch
  const handleClosePosition = async (trade) => {
    if (!session?.access_token) return;
    const confirmClose = window.confirm(`Are you sure you want to Cancel/Close the active setup for ${trade.symbol}?`);
    if (!confirmClose) return;
    setClosingId(trade.id);
    
    try {
        const closingSide = (trade.side === 'BUY' || trade.side === 'LONG') ? 'SELL' : 'BUY';
        const closeRes = await fetch('/api/close-position', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                trade_id: trade.id,
                symbol: trade.symbol,
                side: closingSide,
                qty: trade.qty,
                price: 0
            })
        });
        fetchAuditTrail(); 
    } catch (e) {
        alert(`Cancel Failed: ${e.message}`);
    } finally {
        setClosingId(null);
    }
  };

  const uniqueAssets = [...new Set(pipelines.map(p => p.asset).filter(Boolean))];
  const sortedAndFilteredPipelines = [...pipelines]
    .filter(p => {
      // 🟢 Filter by Asset
      if (assetFilter !== 'ALL' && p.asset !== assetFilter) return false;
      
      // 🟢 Filter by Status
      if (statusFilter === 'EXECUTED' && p.type !== 'FULL_TRADE') return false;
      if (statusFilter === 'VETOED') {
        const isScanVeto = p.scan?.status?.toUpperCase().includes('VETO');
        const isTradeVeto = p.trade?.reason?.toUpperCase().includes('VETO');
        if (!isScanVeto && !isTradeVeto) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // 🟢 Pin Active Positions to the top
      const isOpenA = a.type === 'FULL_TRADE' && a.trade && !a.trade.exit_price;
      const isOpenB = b.type === 'FULL_TRADE' && b.trade && !b.trade.exit_price;
      if (isOpenA && !isOpenB) return -1;
      if (!isOpenA && isOpenB) return 1; 
      
      // 🟢 Then sort by timestamp
      return b.timestamp - a.timestamp;
    });

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-4 md:p-6 font-sans flex flex-col gap-6 max-w-[100vw] overflow-x-hidden">
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes travel { 0% { left: 0%; opacity: 0; box-shadow: 0 0 10px #10b981; background: #10b981; } 10% { opacity: 1; } 40% { box-shadow: 0 0 15px #f59e0b; background: #f59e0b; } 70% { box-shadow: 0 0 20px #06b6d4; background: #06b6d4; } 90% { opacity: 1; } 100% { left: 100%; opacity: 0; box-shadow: 0 0 25px #a855f7; background: #a855f7; } }
        .animate-travel { animation: travel 3s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
      `}} />

      <header className="max-w-7xl w-full mx-auto flex flex-col lg:flex-row justify-between items-center pb-4 border-b border-white/10 gap-4">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <div className="p-2 md:p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl"><Activity className="text-indigo-400" size={20} md={24} /></div>
          <div>
            <h1 className="text-xl md:text-2xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Audit Trail</h1>
            <p className="text-[8px] md:text-[10px] text-slate-500 font-mono uppercase tracking-widest mt-1">Unified Pipeline Diagnostics</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 md:gap-4 bg-slate-900/50 p-2 rounded-2xl border border-white/5 w-full lg:w-auto justify-between">
          <div className="flex gap-2">
             <button onClick={() => setStatusFilter('ALL')} className={`text-[8px] md:text-[9px] font-black uppercase px-2 md:px-3 py-1.5 rounded-lg border ${statusFilter === 'ALL' ? 'bg-indigo-500/20 border-indigo-500/30 text-indigo-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}>All</button>
             <button onClick={() => setStatusFilter('EXECUTED')} className={`text-[8px] md:text-[9px] font-black uppercase px-2 md:px-3 py-1.5 rounded-lg border ${statusFilter === 'EXECUTED' ? 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}>Executed</button>
             <button onClick={() => setStatusFilter('VETOED')} className={`text-[8px] md:text-[9px] font-black uppercase px-2 md:px-3 py-1.5 rounded-lg border ${statusFilter === 'VETOED' ? 'bg-red-500/20 border-red-500/30 text-red-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}>Vetoes</button>
             <button onClick={() => setShowRiskBlocks(!showRiskBlocks)} className={`text-[8px] md:text-[9px] font-black uppercase px-2 md:px-3 py-1.5 rounded-lg border ${showRiskBlocks ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'border-white/5 text-slate-500 hover:bg-white/5'}`}>🚫 Risk Blocks ({riskBlocks.length})</button>
          </div>
          <div className="flex items-center gap-2 px-3 border-l border-white/10">
            <Filter size={14} className="text-slate-400" />
            <select className="bg-transparent text-[9px] md:text-[10px] font-black uppercase tracking-widest text-cyan-300 focus:outline-none cursor-pointer" value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
              <option value="ALL">All Assets</option>
              {uniqueAssets.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <button onClick={fetchAuditTrail} className="p-2 hover:bg-white/5 rounded-xl transition-all" title="Refresh Feed"><RefreshCw size={16} className={`text-slate-400 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </header>

      {/* LIVE ANIMATION PIPELINE */}
      <div className="max-w-7xl w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl relative overflow-hidden">
         <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 via-cyan-500/5 to-purple-500/5" />
         <div className="absolute top-1/2 left-[5%] right-[5%] md:left-[10%] md:right-[10%] h-[2px] bg-slate-800 -translate-y-1/2 rounded-full overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-slate-600 transition-all duration-1000" style={{ width: `${liveState.progress}%` }} />
            {liveState.scanning && <div className="absolute top-1/2 -translate-y-1/2 w-4 h-1 rounded-full animate-travel z-20" />}
         </div>

         <div className="relative z-10 flex items-center justify-between max-w-4xl mx-auto gap-2">
            <div className="flex flex-col items-center gap-2 md:gap-3 w-16 md:w-24 bg-slate-900 p-2 rounded-xl border border-white/5 shadow-lg">
               <div className={`w-10 h-10 md:w-12 md:h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.scanning ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_20px_-2px_rgba(16,185,129,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}><Zap size={16} className={liveState.scanning ? 'animate-pulse' : ''} /></div>
               <span className={`text-[8px] md:text-[9px] font-black uppercase tracking-widest ${liveState.scanning ? 'text-emerald-300' : 'text-slate-500'}`}>Scanner</span>
            </div>
            <div className="flex flex-col items-center gap-2 md:gap-3 w-16 md:w-24 bg-slate-900 p-2 rounded-xl border border-white/5 shadow-lg">
               <div className={`w-10 h-10 md:w-12 md:h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.oracle ? 'bg-amber-500/20 border-amber-500/50 text-amber-400 shadow-[0_0_20px_-2px_rgba(245,158,11,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}><BrainCircuit size={16} className={liveState.oracle ? 'animate-pulse' : ''} /></div>
               <span className={`text-[8px] md:text-[9px] font-black uppercase tracking-widest ${liveState.oracle ? 'text-amber-300' : 'text-slate-500'}`}>Oracle</span>
            </div>
            <div className="flex flex-col items-center gap-2 md:gap-3 w-16 md:w-24 bg-slate-900 p-2 rounded-xl border border-white/5 shadow-lg">
               <div className={`w-10 h-10 md:w-12 md:h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.executing ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_20px_-2px_rgba(6,182,212,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}><Server size={16} className={liveState.executing ? 'animate-pulse' : ''} /></div>
               <span className={`text-[8px] md:text-[9px] font-black uppercase tracking-widest ${liveState.executing ? 'text-cyan-300' : 'text-slate-500'}`}>Exchange</span>
            </div>
            <div className="flex flex-col items-center gap-2 md:gap-3 w-16 md:w-24 bg-slate-900 p-2 rounded-xl border border-white/5 shadow-lg">
               <div className={`w-10 h-10 md:w-12 md:h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.resting ? 'bg-purple-500/20 border-purple-500/50 text-purple-400 shadow-[0_0_20px_-2px_rgba(168,85,247,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}><Crosshair size={16} className={liveState.resting ? 'animate-spin-slow' : ''} /></div>
               <span className={`text-[8px] md:text-[9px] font-black uppercase tracking-widest ${liveState.resting ? 'text-purple-300' : 'text-slate-500'}`}>Limits</span>
            </div>
         </div>
      </div>

      <main className="max-w-7xl w-full mx-auto space-y-6">
        {sortedAndFilteredPipelines.map((pipeline, i) => {
          const isVeto = pipeline.type === 'ORPHAN_SCAN' && pipeline.scan?.status?.includes('VETO');
          const isFullTrade = pipeline.type === 'FULL_TRADE';
          const t = pipeline.trade;
          const s = pipeline.scan;
          const isOpenTrade = isFullTrade && !t?.exit_price;

          const originalTradeReason = t?.reason?.split('[EXIT TRIGGER]:')[0]?.trim();
          let displayReasoning = originalTradeReason || s?.telemetry?.oracle_reasoning || '';
          
          // 🟢 THE FIX: Safely parse and extract the Expectancy Metrics
          let expectancies = null;
          if (displayReasoning.includes('[EXPECTANCIES]')) {
              const match = displayReasoning.match(/\[EXPECTANCIES\] Fill: (.*?)m \| TP: (.*?)m \| R:R: (.*?)(?:\n|$)/);
              if (match) {
                  expectancies = { fill: match[1], tp: match[2], rr: match[3] };
                  displayReasoning = displayReasoning.replace(match[0], '').trim();
              }
          }

          return (
            <div key={i} className={`p-5 rounded-3xl border transition-all duration-300 ${
              isOpenTrade ? 'bg-emerald-950/40 border-emerald-500/40 shadow-[0_0_40px_-10px_rgba(16,185,129,0.15)]' 
              : isFullTrade ? 'bg-slate-900/60 border-indigo-500/20 shadow-[0_0_30px_-10px_rgba(99,102,241,0.1)]' 
              : (isVeto ? 'bg-red-950/10 border-red-500/20' : 'bg-slate-900/30 border-white/10')
            }`}>
              
              <div className="flex flex-col sm:flex-row justify-between items-start gap-3 sm:gap-2 mb-4 border-b border-white/5 pb-4">
                 <div className="flex flex-col gap-2 min-w-0">
                    <div className="flex items-center flex-wrap gap-3">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-2 ${isOpenTrade ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : isFullTrade ? 'bg-indigo-500/20 text-indigo-300' : (isVeto ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-slate-800 text-slate-400')}`}>
                        {isOpenTrade && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                        {isOpenTrade ? 'Active Position' : isFullTrade ? 'Pipeline Executed' : (isVeto ? 'Oracle Veto' : 'Scan Log')}
                        </span>
                        {/* 🟢 Shadow verdict badge */}
                        {(() => {
                          const shadow = shadowRecords.find(s => s.scan_id === pipeline.scan?.id);
                          if (!shadow) return null;
                          return (
                            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${
                              shadow.verdict === 'SAVED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                              shadow.verdict === 'MISSED' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                              'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                            }`}>
                              {shadow.verdict === 'SAVED' ? '✅ SAVED' : shadow.verdict === 'MISSED' ? '❌ MISSED' : '➖ NEUTRAL'}
                              {shadow.saved_amount > 0 && ` $${parseFloat(shadow.saved_amount).toFixed(2)}`}
                              {shadow.missed_amount > 0 && ` -$${parseFloat(shadow.missed_amount).toFixed(2)}`}
                            </span>
                          );
                        })()}
                        <span className="text-sm font-bold text-white">{pipeline.asset}</span>
                        <span className="text-xs text-slate-500 font-mono">{pipeline.strategy}</span>
                    </div>
                    <span className="text-[11px] text-slate-500 font-mono pl-1">{new Date(pipeline.timestamp).toLocaleString()}</span>
                 </div>
                 
                 {/* 🟢 THE FIX: Dual Control Panel for Active Trades.
                     Mobile: full-width, wraps, buttons never shrink/clip off the edge. */}
                 {isOpenTrade && (
                    <div className="flex flex-wrap gap-2 w-full sm:w-auto shrink-0">
                        <button 
                            onClick={() => handleForceReview(t.id)}
                            disabled={reviewingId === t.id}
                            className={`flex-1 sm:flex-none whitespace-nowrap flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                                reviewingId === t.id 
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50 cursor-not-allowed' 
                                : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/40 hover:shadow-[0_0_15px_-3px_rgba(99,102,241,0.4)]'
                            }`}
                        >
                            {reviewingId === t.id ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
                            {reviewingId === t.id ? 'Analyzing...' : 'Force AI Review'}
                        </button>

                        <button 
                            onClick={() => handleClosePosition(t)}
                            disabled={closingId === t.id}
                            className={`flex-1 sm:flex-none whitespace-nowrap flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                                closingId === t.id 
                                ? 'bg-red-500/20 text-red-400 border border-red-500/50 cursor-not-allowed' 
                                : 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 hover:shadow-[0_0_15px_-3px_rgba(239,68,68,0.4)]'
                            }`}
                        >
                            {closingId === t.id ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                            {closingId === t.id ? 'Closing...' : 'Close / Cancel'}
                        </button>
                    </div>
                 )}
              </div>

              <div className="flex flex-col gap-4 pl-2">
                {s && s.telemetry && (
                  <div className="border-l-2 border-emerald-500/30 pl-4 py-1">
                     <h4 className="text-[10px] font-black uppercase tracking-widest text-emerald-400 flex items-center gap-2 mb-2"><Zap size={12}/> Scanner Telemetry</h4>
                     <div className="flex flex-wrap gap-4 bg-black/20 p-3 rounded-xl border border-white/5">
                        {Object.entries(s.telemetry).filter(([k]) => k !== 'oracle_reasoning').map(([k, v]) => (
                          <div key={k} className="flex flex-col">
                            <span className="text-[9px] text-slate-500 uppercase tracking-wider">{k}</span>
                            <span className="text-[11px] text-slate-300 font-mono">{typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? v.toFixed(4) : v}</span>
                          </div>
                        ))}
                     </div>
                  </div>
                )}

                <ThesisDisplay 
                  reasoning={displayReasoning} 
                  isVeto={isVeto} 
                  score={s?.telemetry?.oracle_score} 
                />

                {/* 🟢 THE FIX: Rendering the new Expectancy Metrics cleanly */}
                {expectancies && (
                  <div className="border-l-2 border-indigo-500/30 pl-4 py-1">
                     <h4 className="text-[10px] font-black uppercase tracking-widest text-indigo-400 flex items-center gap-2 mb-2"><Clock size={12}/> Trade Expectancies</h4>
                     <div className="flex flex-wrap items-center gap-6 bg-black/20 p-3 rounded-xl border border-white/5">
                        <span className="text-[11px] text-slate-400 font-mono">Fill Expectancy: <span className="text-white">{expectancies.fill}m</span></span>
                        <span className="text-[11px] text-slate-400 font-mono">TP Expectancy: <span className="text-white">{expectancies.tp}m</span></span>
                        <span className="text-[11px] text-slate-400 font-mono">Risk/Reward: <span className="text-emerald-400">{expectancies.rr}</span></span>
                     </div>
                  </div>
                )}

                {t && (
                  <div className="border-l-2 border-cyan-500/30 pl-4 py-1">
                     <h4 className="text-[10px] font-black uppercase tracking-widest text-cyan-400 flex items-center gap-2 mb-2"><Server size={12}/> Exchange Routing</h4>
                     <div className="flex flex-wrap items-center gap-6 bg-black/20 p-3 rounded-xl border border-white/5">
                        <span className={`text-sm font-black uppercase ${t.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side} {t.qty}</span>
                        <span className="text-slate-300 font-mono text-sm">@ ${t.entry_price}</span>
                        <span className="text-[10px] bg-white/5 px-2 py-1 rounded text-slate-400 font-mono border border-white/10 uppercase">{t.execution_mode}</span>
                        {t.market_type && <span className="text-[10px] text-slate-500 font-mono uppercase">{t.market_type} ({t.leverage}x)</span>}
                     </div>
                  </div>
                )}

                {/* 🛠️ Agent Tool Calls */}
                {pipeline.toolCalls && pipeline.toolCalls.length > 0 && (() => {
                  const isExpanded = expandedMemories[`${pipeline.timestamp}-tools`];
                  return (
                    <div className="border-l-2 border-amber-500/30 pl-4 py-1">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-2">
                          <Crosshair size={12}/> Agent Tool Calls ({pipeline.toolCalls.length})
                        </h4>
                        <button
                          onClick={() => setExpandedMemories(prev => ({ ...prev, [`${pipeline.timestamp}-tools`]: !prev[`${pipeline.timestamp}-tools`] }))}
                          className="text-[9px] font-black uppercase tracking-widest text-amber-300 hover:text-amber-200 flex items-center gap-1"
                        >
                          {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {pipeline.toolCalls.length} <ChevronDown size={10}/></>}
                        </button>
                      </div>
                      {isExpanded && (
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
                              {pipeline.toolCalls.map(tc => (
                                <tr key={tc.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
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
                          {pipeline.toolCalls.some(tc => tc.response_summary) && (
                            <div className="p-3 border-t border-white/5 bg-black/30">
                              <p className="text-[8px] uppercase tracking-widest text-slate-500 mb-1">Response:</p>
                              <pre className="text-[9px] text-slate-400 whitespace-pre-wrap break-all leading-relaxed">
                                {pipeline.toolCalls.map(tc => `[${tc.tool_name}] ${tc.response_summary || ''}`).join('\n').substring(0, 500)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {t && (t.tp_price || t.sl_price || t.exit_price) && (
                  <div className={`border-l-2 pl-4 py-1 ${t.exit_price ? 'border-slate-500/30' : 'border-purple-500/30'}`}>
                     <h4 className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mb-2 ${t.exit_price ? 'text-slate-400' : 'text-purple-400'}`}>
                        <Crosshair size={12}/> {t.exit_price ? 'Trade Closed' : 'Resting Limits'}
                     </h4>
                     <div className="flex flex-col gap-2 bg-black/20 p-3 rounded-xl border border-white/5">
                        <div className="flex gap-6 text-[11px] font-mono">
                           {t.tp_price && <span>Take Profit: <span className="text-emerald-500/70">${t.tp_price}</span></span>}
                           {t.sl_price && <span>Stop Loss: <span className="text-red-500/70">${t.sl_price}</span></span>}
                        </div>
                        {t.exit_price && (
                          <div className="flex flex-wrap items-center gap-4 mt-2 pt-2 border-t border-white/5">
                             <span className="text-[11px] text-slate-400 font-mono">Exit Price: <span className="text-white">${t.exit_price}</span></span>
                             <span className={`text-[11px] font-black ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>PnL: {t.pnl >= 0 ? '+' : ''}${t.pnl}</span>
                             {t.reason && t.reason.includes('[EXIT TRIGGER]') && (
                               <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-1 rounded border border-white/10">
                                 Exit Trigger: {t.reason.split('[EXIT TRIGGER]:')[1]?.trim()}
                               </span>
                             )}
                          </div>
                        )}
                     </div>
                  </div>
                )}

                {/* 🧠 Core Memory (Influenced This Trade) */}
                {t && (() => {
                  const forwardMems = (t.influencing_memory_ids || [])
                    .map(id => linkedMemories[id] || Object.values(linkedMemories).find(m => String(m.id) === String(id)))
                    .filter(Boolean);
                  if (forwardMems.length === 0) return null;
                  const isExpanded = expandedMemories[`${t.id}-influenced`];
                  return (
                    <div className="border-l-2 border-indigo-500/30 pl-4 py-1">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-[9px] font-black uppercase tracking-widest text-indigo-400 flex items-center gap-2">
                          🧠 Core Memory (Influenced This Trade)
                        </h4>
                        <button
                          onClick={() => setExpandedMemories(prev => ({ ...prev, [`${t.id}-influenced`]: !prev[`${t.id}-influenced`] }))}
                          className="text-[9px] font-black uppercase tracking-widest text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
                        >
                          {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {forwardMems.length} <ChevronDown size={10}/></>}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="space-y-2 mt-2">
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
                {t && (() => {
                  const generatedMem = Object.values(linkedMemories)
                    .filter(m => m.trade_log_id && String(m.trade_log_id) === String(t.id));
                  if (generatedMem.length === 0) return null;
                  const isExpanded = expandedMemories[`${t.id}-generated`];
                  return (
                    <div className="border-l-2 border-emerald-500/30 pl-4 py-1">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-[9px] font-black uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                          🧠 Core Memory (Generated By This Trade)
                        </h4>
                        <button
                          onClick={() => setExpandedMemories(prev => ({ ...prev, [`${t.id}-generated`]: !prev[`${t.id}-generated`] }))}
                          className="text-[9px] font-black uppercase tracking-widest text-emerald-300 hover:text-emerald-200 flex items-center gap-1"
                        >
                          {isExpanded ? <>Collapse <ChevronUp size={10}/></> : <>View {generatedMem.length} <ChevronDown size={10}/></>}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="space-y-2 mt-2">
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
              </div>
            </div>
          );
        })}

        {showRiskBlocks && riskBlocks.map((rb, i) => (
          <div key={i} className="p-4 rounded-2xl border border-red-500/20 bg-slate-900/60">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-3">
                <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest bg-red-500/10 text-red-400">RISK BLOCK</span>
                <span className="text-sm font-bold text-white">{rb.asset}</span>
                <span className="text-[10px] text-slate-500 font-mono">{rb.execution_mode}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{new Date(rb.created_at).toLocaleString()}</span>
            </div>
            <div className="flex flex-wrap gap-3 text-[10px] text-slate-400 font-mono pl-2 mb-2">
              <span>{rb.side} {rb.entry_price ? `@ $${rb.entry_price}` : ''}</span>
              <span>Qty: {rb.qty}</span>
              <span>{rb.leverage}x</span>
            </div>
            <div className="border-l-2 border-red-500/30 pl-3">
              <p className="text-[11px] text-red-300 italic">{rb.reason}</p>
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}