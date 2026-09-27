import React, { useState, useEffect } from 'react';
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
  Activity
} from 'lucide-react';
import { STUDIO_TIERS, hasStudioAccess } from '../lib/entitlements.js';

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
  const loadStrategyDetail = async (strategyName) => {
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
        setActiveTab('BUILDER');
      }
    } catch (err) {
      console.error('Failed to load strategy details:', err);
    }
  };

  useEffect(() => {
    if (router.isReady && router.query.strategy && session?.access_token) {
      loadStrategyDetail(router.query.strategy);
    }
  }, [router.isReady, router.query.strategy, session]);

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
          </div>
        </div>

        {/* Tier Gate Lock Banner (Cosmetic - API remains server-gated) */}
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

        {/* TAB 2: BUILDER (Code viewer + version history this push) */}
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
                        Read-only (AM45) • In-browser Editor lands in AM46
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

        {/* TAB 3: BACKTEST PLACEHOLDER */}
        {activeTab === 'BACKTEST' && (
          <div className="bg-slate-900/40 border border-white/5 rounded-3xl p-12 text-center space-y-4 max-w-2xl mx-auto my-8">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mx-auto">
              <Play className="w-6 h-6 ml-0.5" />
            </div>
            <h2 className="text-xl font-black italic tracking-tighter uppercase text-white">
              Backtest Engine — AM46
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Historical candle replay, trade simulations, and parameter visualizer will land in PUSH AM46.
              The backtester will run closed-bar simulations strictly using live Coinbase execution candle shape for 100% parity with live sniper execution.
            </p>
            <div className="pt-2">
              <span className="text-[10px] font-black uppercase tracking-widest bg-white/5 text-slate-400 px-3 py-1.5 rounded-lg border border-white/5">
                Foundation Deployed (AM45)
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
