import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { 
  Terminal as TerminalIcon, Activity, Layers, Filter, RefreshCw, ShieldAlert, CheckCircle2, Zap 
} from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function AuditLog() {
  const [unifiedLogs, setUnifiedLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const fetchAuditTrail = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch Scanner / Oracle Logic
      const { data: scans } = await supabase
        .from('scan_results')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(150);

      // 2. Fetch Trade Executions
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(150);

      // 3. Format and Merge
      const formattedScans = (scans || []).map(s => ({
        ...s,
        log_type: 'SCAN',
        timestamp: new Date(s.created_at).getTime(),
        display_time: new Date(s.created_at).toLocaleString()
      }));

      const formattedTrades = (trades || []).map(t => ({
        ...t,
        log_type: 'TRADE',
        asset: t.symbol, // Normalize column name for filtering
        status: t.exit_price ? 'CLOSED' : 'OPEN',
        timestamp: new Date(t.created_at).getTime(),
        display_time: new Date(t.created_at).toLocaleString()
      }));

      // Sort combined array chronologically (newest first)
      const merged = [...formattedScans, ...formattedTrades].sort((a, b) => b.timestamp - a.timestamp);
      setUnifiedLogs(merged);
    } catch (err) {
      console.error("[AUDIT FAULT]:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuditTrail();
  }, [fetchAuditTrail]);

  // Filtering Logic
  const filteredLogs = unifiedLogs.filter(log => {
    if (assetFilter !== 'ALL' && log.asset !== assetFilter) return false;
    if (typeFilter !== 'ALL' && log.log_type !== typeFilter) return false;
    return true;
  });

  const uniqueAssets = [...new Set(unifiedLogs.map(l => l.asset).filter(Boolean))];

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 p-6 font-sans">
      <header className="max-w-[1600px] w-full mx-auto flex flex-col md:flex-row justify-between items-center border-b border-white/10 pb-6 mb-6 gap-4">
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
              className="bg-transparent text-[10px] font-black uppercase tracking-widest text-indigo-300 focus:outline-none cursor-pointer"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="ALL">All Events</option>
              <option value="SCAN">Scans & Oracle</option>
              <option value="TRADE">Trade Executions</option>
            </select>
          </div>
          <div className="flex items-center gap-2 px-3">
            <Layers size={14} className="text-slate-400" />
            <select 
              className="bg-transparent text-[10px] font-black uppercase tracking-widest text-cyan-300 focus:outline-none cursor-pointer"
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
            >
              <option value="ALL">All Assets</option>
              {uniqueAssets.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <button 
            onClick={fetchAuditTrail}
            className="p-2 hover:bg-white/5 rounded-xl transition-all"
            title="Refresh Feed"
          >
            <RefreshCw size={16} className={`text-slate-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto relative">
        {/* Timeline Line */}
        <div className="absolute left-[39px] top-4 bottom-0 w-px bg-gradient-to-b from-indigo-500/20 via-white/5 to-transparent z-0" />

        <div className="space-y-4 relative z-10">
          {filteredLogs.map((log, i) => {
            const isScan = log.log_type === 'SCAN';
            const isVeto = isScan && log.status?.includes('VETO');
            
            return (
              <div key={i} className="flex gap-6 group">
                {/* Timeline Node */}
                <div className="flex flex-col items-center pt-1 mt-1">
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center bg-[#020617] transition-all duration-300 shadow-[0_0_15px_-3px_rgba(0,0,0,0.5)] 
                    ${isScan 
                      ? (isVeto ? 'border-amber-500/50 text-amber-400 shadow-amber-500/20' : 'border-indigo-500/50 text-indigo-400 shadow-indigo-500/20') 
                      : 'border-emerald-500/50 text-emerald-400 shadow-emerald-500/20 group-hover:scale-110 group-hover:bg-emerald-500/10'}`}
                  >
                    {isScan ? (isVeto ? <ShieldAlert size={10} /> : <Zap size={10} />) : <CheckCircle2 size={10} />}
                  </div>
                </div>

                {/* Log Content Card */}
                <div className={`flex-grow p-4 rounded-2xl border transition-all duration-300
                  ${isScan 
                    ? 'bg-slate-900/40 border-white/5 hover:border-indigo-500/30' 
                    : 'bg-emerald-950/20 border-emerald-500/20 shadow-[0_0_30px_-10px_rgba(16,185,129,0.1)] hover:border-emerald-500/40'}`}
                >
                  <div className="flex justify-between items-start mb-3 border-b border-white/5 pb-3">
                    <div className="flex items-center gap-3">
                      <span className={`text-[11px] font-black uppercase tracking-widest px-2 py-0.5 rounded border 
                        ${isScan ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'}`}>
                        {log.log_type}
                      </span>
                      <span className="text-[12px] font-bold text-white">{log.asset}</span>
                      <span className="text-[10px] text-slate-500 font-mono border-l border-white/10 pl-3">
                        {log.strategy || log.strategy_id}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">{log.display_time}</span>
                  </div>

                  {/* Dynamic Render based on Log Type */}
                  {isScan ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-slate-500 uppercase tracking-widest font-black">Status:</span>
                        <span className={`text-[10px] font-bold ${isVeto ? 'text-amber-400' : 'text-slate-300'}`}>{log.status}</span>
                      </div>
                      {log.telemetry && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 bg-black/30 p-3 rounded-xl border border-white/5">
                          {Object.entries(log.telemetry).map(([k, v]) => {
                            if (k === 'oracle_reasoning') return null; // Handle long text separately
                            return (
                              <div key={k} className="flex flex-col">
                                <span className="text-[8px] text-slate-500 uppercase tracking-widest">{k}</span>
                                <span className="text-[10px] text-slate-300 font-mono">
                                  {typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? v.toFixed(4) : v}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {log.telemetry?.oracle_reasoning && (
                        <div className="mt-2 text-[11px] text-slate-400 leading-relaxed border-l-2 border-indigo-500/30 pl-3">
                          <span className="text-indigo-400 font-bold block mb-1">Oracle Reasoning:</span>
                          {log.telemetry.oracle_reasoning}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-4">
                        <span className={`text-[14px] font-black uppercase ${log.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {log.side} {log.qty}
                        </span>
                        <span className="text-slate-300 font-mono text-[12px]">@ ${log.entry_price}</span>
                        <span className="text-[10px] bg-white/5 px-2 py-1 rounded text-slate-400 font-mono border border-white/10 uppercase">
                          {log.execution_mode}
                        </span>
                      </div>
                      
                      <div className="flex gap-4 text-[10px] font-mono text-slate-500">
                        {log.tp_price && <span>TP: <span className="text-emerald-500/70">${log.tp_price}</span></span>}
                        {log.sl_price && <span>SL: <span className="text-red-500/70">${log.sl_price}</span></span>}
                        <span>Status: <span className={log.exit_price ? 'text-slate-400' : 'text-cyan-400 animate-pulse'}>{log.status}</span></span>
                        {log.exit_price && <span>Exit: ${log.exit_price}</span>}
                      </div>

                      {log.reason && (
                        <div className="mt-1 text-[10px] text-slate-400 leading-relaxed border-l-2 border-emerald-500/30 pl-3 whitespace-pre-wrap">
                          {log.reason}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {filteredLogs.length === 0 && (
            <div className="text-center py-20 text-slate-500 flex flex-col items-center">
              <TerminalIcon size={32} className="opacity-20 mb-3" />
              <p className="text-xs uppercase tracking-widest font-black">No telemetry found</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}