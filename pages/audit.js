import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  Activity, Filter, RefreshCw, ShieldAlert, CheckCircle2, Zap, 
  BrainCircuit, Server, Crosshair, ArrowRight, XCircle
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function AuditLog() {
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assetFilter, setAssetFilter] = useState('ALL');
  
  // Visualizer States
  const [liveState, setLiveState] = useState({
    scanning: false, oracle: false, executing: false, resting: false
  });

  const fetchAuditTrail = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch Data
      const [{ data: scans }, { data: trades }] = await Promise.all([
        supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('trade_logs').select('*').order('created_at', { ascending: false }).limit(200)
      ]);

      // 2. Calculate Live Header State
      const now = Date.now();
      const latestScan = scans?.[0];
      const latestTrade = trades?.[0];
      
      const scanAge = latestScan ? now - new Date(latestScan.created_at).getTime() : Infinity;
      const tradeAge = latestTrade ? now - new Date(latestTrade.created_at).getTime() : Infinity;

      setLiveState({
        scanning: scanAge < 60000, 
        oracle: scanAge < 60000 && latestScan?.status === 'RESONANT',
        executing: tradeAge < 120000 && latestTrade?.exit_price === null, 
        resting: tradeAge < 120000 && latestTrade?.exit_price === null && latestTrade?.tp_price
      });

      // 3. The Stitching Algorithm (Match Trades to their Scans)
      const groupedPipelines = [];
      const usedScans = new Set();

      (trades || []).forEach(trade => {
        const tradeTime = new Date(trade.created_at).getTime();
        
        // Find the closest scan for this asset/strategy within a 5-minute window prior to the trade
        const relatedScan = (scans || []).find(s => {
          if (usedScans.has(s.id)) return false;
          const scanTime = new Date(s.created_at).getTime();
          const timeDiff = tradeTime - scanTime;
          return s.asset === trade.symbol && s.strategy === trade.strategy_id && timeDiff >= 0 && timeDiff < 300000;
        });

        if (relatedScan) usedScans.add(relatedScan.id);

        groupedPipelines.push({
          type: 'FULL_TRADE',
          asset: trade.symbol,
          strategy: trade.strategy_id,
          timestamp: tradeTime,
          trade: trade,
          scan: relatedScan || null,
        });
      });

      // 4. Add Orphaned Scans (Vetos, Failures, or purely informational scans)
      (scans || []).forEach(scan => {
        if (!usedScans.has(scan.id)) {
          groupedPipelines.push({
            type: 'ORPHAN_SCAN',
            asset: scan.asset,
            strategy: scan.strategy,
            timestamp: new Date(scan.created_at).getTime(),
            scan: scan,
            trade: null
          });
        }
      });

      // Sort everything chronologically
      groupedPipelines.sort((a, b) => b.timestamp - a.timestamp);
      setPipelines(groupedPipelines);

    } catch (err) {
      console.error("[AUDIT FAULT]:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuditTrail();
    const interval = setInterval(fetchAuditTrail, 10000); // Auto-refresh every 10s
    return () => clearInterval(interval);
  }, [fetchAuditTrail]);

  const uniqueAssets = [...new Set(pipelines.map(p => p.asset).filter(Boolean))];
  const filteredPipelines = pipelines.filter(p => assetFilter === 'ALL' || p.asset === assetFilter);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-6 font-sans flex flex-col gap-6">
      
      {/* HEADER */}
      <header className="max-w-[1400px] w-full mx-auto flex flex-col md:flex-row justify-between items-center pb-4 border-b border-white/10 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
            <Activity className="text-indigo-400" size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus Audit Trail</h1>
            <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mt-1">Unified Pipeline Diagnostics</p>
          </div>
        </div>

        <div className="flex items-center gap-4 bg-slate-900/50 p-2 rounded-2xl border border-white/5">
          <div className="flex items-center gap-2 px-3 border-r border-white/10">
            <Filter size={14} className="text-slate-400" />
            <select 
              className="bg-transparent text-[10px] font-black uppercase tracking-widest text-cyan-300 focus:outline-none cursor-pointer"
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
            >
              <option value="ALL">All Assets Filter</option>
              {uniqueAssets.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <button onClick={fetchAuditTrail} className="p-2 hover:bg-white/5 rounded-xl transition-all" title="Refresh Feed">
            <RefreshCw size={16} className={`text-slate-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* LIVE ANIMATION PIPELINE */}
      <div className="max-w-[1400px] w-full mx-auto bg-slate-900/40 border border-white/10 rounded-3xl p-6 shadow-2xl relative overflow-hidden">
         <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 via-cyan-500/5 to-purple-500/5" />
         <div className="relative z-10 flex items-center justify-between max-w-4xl mx-auto">
            
            {/* SCANNER */}
            <div className="flex flex-col items-center gap-3 w-24">
               <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.scanning ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_20px_-2px_rgba(16,185,129,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}>
                   <Zap size={20} className={liveState.scanning ? 'animate-pulse' : ''} />
               </div>
               <span className={`text-[9px] font-black uppercase tracking-widest ${liveState.scanning ? 'text-emerald-300' : 'text-slate-500'}`}>Scanner</span>
            </div>

            <ArrowRight className={`transition-all duration-500 ${liveState.oracle ? 'text-emerald-500/50' : 'text-slate-800'}`} />

            {/* ORACLE */}
            <div className="flex flex-col items-center gap-3 w-24">
               <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.oracle ? 'bg-amber-500/20 border-amber-500/50 text-amber-400 shadow-[0_0_20px_-2px_rgba(245,158,11,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}>
                   <BrainCircuit size={20} className={liveState.oracle ? 'animate-pulse' : ''} />
               </div>
               <span className={`text-[9px] font-black uppercase tracking-widest ${liveState.oracle ? 'text-amber-300' : 'text-slate-500'}`}>Oracle</span>
            </div>

            <ArrowRight className={`transition-all duration-500 ${liveState.executing ? 'text-amber-500/50' : 'text-slate-800'}`} />

            {/* EXECUTION */}
            <div className="flex flex-col items-center gap-3 w-24">
               <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.executing ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400 shadow-[0_0_20px_-2px_rgba(6,182,212,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}>
                   <Server size={20} className={liveState.executing ? 'animate-pulse' : ''} />
               </div>
               <span className={`text-[9px] font-black uppercase tracking-widest ${liveState.executing ? 'text-cyan-300' : 'text-slate-500'}`}>Exchange</span>
            </div>

            <ArrowRight className={`transition-all duration-500 ${liveState.resting ? 'text-cyan-500/50' : 'text-slate-800'}`} />

            {/* BRACKETS */}
            <div className="flex flex-col items-center gap-3 w-24">
               <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${liveState.resting ? 'bg-purple-500/20 border-purple-500/50 text-purple-400 shadow-[0_0_20px_-2px_rgba(168,85,247,0.5)]' : 'bg-slate-950 border-white/10 text-slate-600'}`}>
                   <Crosshair size={20} className={liveState.resting ? 'animate-spin-slow' : ''} />
               </div>
               <span className={`text-[9px] font-black uppercase tracking-widest ${liveState.resting ? 'text-purple-300' : 'text-slate-500'}`}>Limits</span>
            </div>

         </div>
      </div>

      {/* UNIFIED LOG FEED */}
      <main className="max-w-[1400px] w-full mx-auto space-y-6">
        {filteredPipelines.map((pipeline, i) => {
          const isVeto = pipeline.type === 'ORPHAN_SCAN' && pipeline.scan?.status?.includes('VETO');
          const isFullTrade = pipeline.type === 'FULL_TRADE';
          const t = pipeline.trade;
          const s = pipeline.scan;

          return (
            <div key={i} className={`p-5 rounded-3xl border transition-all duration-300 ${
              isFullTrade 
                ? 'bg-slate-900/60 border-indigo-500/20 shadow-[0_0_30px_-10px_rgba(99,102,241,0.1)]' 
                : (isVeto ? 'bg-slate-950 border-white/5 opacity-70' : 'bg-slate-900/30 border-white/10')
            }`}>
              
              {/* HEADER */}
              <div className="flex justify-between items-center mb-4 border-b border-white/5 pb-4">
                 <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                      isFullTrade ? 'bg-indigo-500/20 text-indigo-300' : (isVeto ? 'bg-red-500/10 text-red-400' : 'bg-slate-800 text-slate-400')
                    }`}>
                      {isFullTrade ? 'Pipeline Executed' : (isVeto ? 'Oracle Veto' : 'Scan Log')}
                    </span>
                    <span className="text-sm font-bold text-white">{pipeline.asset}</span>
                    <span className="text-xs text-slate-500 font-mono">{pipeline.strategy}</span>
                 </div>
                 <span className="text-[11px] text-slate-500 font-mono">{new Date(pipeline.timestamp).toLocaleString()}</span>
              </div>

              {/* BODY */}
              <div className="flex flex-col gap-4 pl-2">
                
                {/* STAGE 1: SCANNER */}
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

                {/* STAGE 2: ORACLE */}
                {s && s.telemetry?.oracle_reasoning && (
                  <div className={`border-l-2 pl-4 py-1 ${isVeto ? 'border-red-500/30' : 'border-amber-500/30'}`}>
                     <h4 className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mb-2 ${isVeto ? 'text-red-400' : 'text-amber-400'}`}>
                        <BrainCircuit size={12}/> Oracle Analysis {s.telemetry.oracle_score && `(Score: ${s.telemetry.oracle_score})`}
                     </h4>
                     <p className="text-[12px] text-slate-400 leading-relaxed bg-black/20 p-3 rounded-xl border border-white/5 italic">
                        "{s.telemetry.oracle_reasoning}"
                     </p>
                  </div>
                )}

                {/* STAGE 3: EXECUTION */}
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

                {/* STAGE 4: BRACKETS & EXIT */}
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
                                 {t.reason.split('[EXIT TRIGGER]:')[1]?.trim()}
                               </span>
                             )}
                          </div>
                        )}
                     </div>
                  </div>
                )}

              </div>
            </div>
          );
        })}

        {filteredPipelines.length === 0 && (
          <div className="text-center py-20 text-slate-500 flex flex-col items-center">
            <CheckCircle2 size={32} className="opacity-20 mb-3" />
            <p className="text-xs uppercase tracking-widest font-black">Pipeline Clear</p>
          </div>
        )}
      </main>
    </div>
  );
}