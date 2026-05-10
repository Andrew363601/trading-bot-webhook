// components/MarketScanner.js
// Advanced market scanner with favorites, asset browser, and strategy discovery

import React, { useState, useEffect, useRef } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { 
  Search, Star, Settings, Play, Plus, ChevronDown, TrendingUp, TrendingDown,
  Zap, Lock, AlertCircle
} from 'lucide-react';

export default function MarketScanner({ onSelectAsset, currentAsset }) {
  const supabase = useSupabaseClient();
  const session = useSession();
  const token = session?.access_token;

  const [activeTab, setActiveTab] = useState('FAVORITES'); // FAVORITES, BROWSE
  const [allAssets, setAllAssets] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedStrategyId, setExpandedStrategyId] = useState(null);
  const [strategyParams, setStrategyParams] = useState({});
  const [executionMode, setExecutionMode] = useState('PAPER'); // PAPER or LIVE

  // Sync selectedAsset with currentAsset if provided
  useEffect(() => {
    if (currentAsset && (!selectedAsset || selectedAsset.id !== currentAsset)) {
        const asset = allAssets.find(a => a.id === currentAsset);
        if (asset) setSelectedAsset(asset);
    }
  }, [currentAsset, allAssets, selectedAsset]);

  // Fetch all available FUTURES assets
  useEffect(() => {
    const fetchAssets = async () => {
      if (!token) return;
      try {
        const res = await fetch('/api/available-assets', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        setAllAssets(data.products || []);
      } catch (err) {
        console.error('Failed to fetch assets:', err);
      }
    };
    fetchAssets();
  }, [token]);

  // Load favorites from DB
  useEffect(() => {
    const loadFavorites = async () => {
      if (!token || !session?.user?.id) return;
      try {
        const { data: users } = await supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('auth_user_id', session.user.id)
          .single();

        if (!users) return;

        const { data: favAssets } = await supabase
          .from('favorite_assets')
          .select('asset')
          .eq('tenant_id', users.tenant_id);

        setFavorites((favAssets || []).map(f => f.asset));
      } catch (err) {
        console.error('Failed to load favorites:', err);
      }
    };
    loadFavorites();
  }, [token, session, supabase]);

  // When asset selected, fetch applicable strategies
  useEffect(() => {
    const fetchStrategies = async () => {
      if (!selectedAsset || !token) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/get-strategies-for-asset?asset=${selectedAsset.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        setAvailableStrategies(data.strategies || []);
      } catch (err) {
        console.error('Failed to fetch strategies:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchStrategies();
  }, [selectedAsset, token]);

  const toggleFavorite = async (assetName) => {
    if (!token || !session?.user?.id) return;
    try {
      const { data: users } = await supabase
        .from('tenant_users')
        .select('tenant_id')
        .eq('auth_user_id', session.user.id)
        .single();

      if (favorites.includes(assetName)) {
        await supabase
          .from('favorite_assets')
          .delete()
          .eq('tenant_id', users.tenant_id)
          .eq('asset', assetName);
        setFavorites(fav => fav.filter(f => f !== assetName));
      } else {
        await supabase
          .from('favorite_assets')
          .insert([{ tenant_id: users.tenant_id, asset: assetName }]);
        setFavorites(fav => [...fav, assetName]);
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  };

  const subscribeToStrategy = async (strategy) => {
    if (!selectedAsset || !token) return;
    try {
      const res = await fetch('/api/subscribe-strategy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          asset: selectedAsset.id,
          strategy: strategy.id,
          exchange: 'COINBASE',
          product_type: 'FUTURES',
          parameters: {
            ...strategy.parameters,
            ...strategyParams[strategy.id],
            execution_mode: executionMode
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        alert(`✅ Subscribed to ${strategy.name} for ${selectedAsset.name}`);
        setStrategyParams({});
      } else {
        const error = await res.json();
        alert(`❌ ${error.error}`);
      }
    } catch (err) {
      console.error('Failed to subscribe:', err);
      alert('Failed to subscribe to strategy');
    }
  };

  const filteredAssets = allAssets.filter(a => {
    // 1. Tab filtering
    if (activeTab === 'FAVORITES' && !favorites.includes(a.id)) return false;
    if (activeTab === 'PERPS' && !a.id.includes('PERP')) return false;
    if (activeTab === 'FUTURES' && !a.id.includes('-CDE')) return false;
    // 2. Search filtering
    if (searchTerm && !a.id.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="bg-slate-950/50 rounded-2xl p-3 space-y-4 max-h-[500px] overflow-y-auto custom-scrollbar">
      {/* Tabs */}
      <div className="flex gap-2 border-b border-white/10 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setActiveTab('FAVORITES')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'FAVORITES'
              ? 'text-indigo-400 border-b-2 border-indigo-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Star className="w-3 h-3 inline mr-1" />
          Favs
        </button>
        <button
          onClick={() => setActiveTab('BROWSE')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'BROWSE'
              ? 'text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Search className="w-3 h-3 inline mr-1" />
          All
        </button>
        <button
          onClick={() => setActiveTab('PERPS')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'PERPS'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <TrendingUp className="w-3 h-3 inline mr-1" />
          Perps
        </button>
        <button
          onClick={() => setActiveTab('FUTURES')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'FUTURES'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <TrendingDown className="w-3 h-3 inline mr-1" />
          Futures
        </button>
      </div>

      {/* Search */}
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          if (filteredAssets.length > 0) {
            const asset = filteredAssets[0];
            setSelectedAsset(asset);
            setStrategyParams({});
            if (onSelectAsset) onSelectAsset(asset.id);
            setSearchTerm('');
          }
        }}
        className="relative"
      >
        <Search className="absolute left-3 top-2.5 w-3 h-3 text-slate-500" />
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-slate-950 border border-white/5 rounded-xl pl-8 pr-3 py-1.5 text-white text-[10px] placeholder-slate-600 focus:ring-2 focus:ring-indigo-500/50 outline-none uppercase"
        />
      </form>

      <div className="flex flex-col gap-4">
        {/* Asset List */}
        <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
          {allAssets.length === 0 && !loading ? (
            <div className="text-center py-8">
              <div className="text-indigo-500 animate-pulse text-[10px] font-black uppercase mb-2">Syncing with Coinbase...</div>
              <div className="text-slate-600 text-[8px] uppercase">Attempting to map futures matrix</div>
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="text-center py-4 text-[10px] text-slate-500 uppercase tracking-widest font-black">
              Empty Matrix
            </div>
          ) : (
            filteredAssets.map(asset => (
              <button
                key={asset.id}
                onClick={() => {
                  setSelectedAsset(asset);
                  setStrategyParams({});
                  if (onSelectAsset) onSelectAsset(asset.id);
                }}
                className={`w-full text-left px-3 py-2 rounded-xl transition-all border ${
                  selectedAsset?.id === asset.id
                    ? 'bg-indigo-500/20 border-indigo-500/50'
                    : 'bg-slate-950/50 border-white/5 hover:border-white/10'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-black text-[10px] text-white uppercase tracking-tighter">{asset.id}</div>
                    <div className="text-[9px] text-slate-500 font-mono">${asset.price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(asset.id);
                    }}
                    className={`transition-colors p-1 ${
                      favorites.includes(asset.id)
                        ? 'text-yellow-400'
                        : 'text-slate-700 hover:text-slate-500'
                    }`}
                  >
                    <Star className="w-3 h-3" fill={favorites.includes(asset.id) ? "currentColor" : "none"} />
                  </button>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Strategy Discovery */}
        <div className="border-t border-white/5 pt-4">
          {!selectedAsset ? (
            <div className="flex flex-col items-center justify-center py-4 text-slate-600">
              <Zap className="w-6 h-6 mb-2 opacity-20" />
              <p className="text-[9px] font-black uppercase tracking-widest text-center">Select Asset<br/>to Deploy</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-1 w-1 rounded-full bg-indigo-500 animate-pulse" />
                <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Deploy Matrix: {selectedAsset.id}</h3>
              </div>

              {loading ? (
                <div className="flex justify-center py-4">
                  <div className="w-4 h-4 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                </div>
              ) : availableStrategies.length === 0 ? (
                <div className="text-center py-4 text-[9px] text-slate-600 uppercase font-bold">
                  No strategies mapped
                </div>
              ) : (
                availableStrategies.map(strategy => (
                  <div
                    key={strategy.id}
                    className="bg-slate-950 border border-white/5 rounded-xl p-3 space-y-2"
                  >
                    <button
                      onClick={() => setExpandedStrategyId(
                        expandedStrategyId === strategy.id ? null : strategy.id
                      )}
                      className="w-full flex justify-between items-center group"
                    >
                      <div className="text-left">
                        <h4 className="font-black text-[10px] text-white uppercase tracking-tighter group-hover:text-indigo-300 transition-colors">{strategy.name}</h4>
                        <p className="text-[8px] text-slate-600 uppercase font-bold">{strategy.description}</p>
                      </div>
                      <ChevronDown
                        className={`w-3 h-3 text-slate-500 transition-transform ${
                          expandedStrategyId === strategy.id ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {expandedStrategyId === strategy.id && (
                      <div className="space-y-3 border-t border-white/5 pt-3">
                        {/* Parameters */}
                        <div className="space-y-2">
                          <div className="space-y-1">
                            <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">
                              Execution Mode
                            </label>
                            <select
                              value={executionMode}
                              onChange={(e) => setExecutionMode(e.target.value)}
                              className="w-full bg-slate-900 border border-white/10 rounded p-1.5 text-white text-[10px] font-bold outline-none"
                            >
                              <option value="PAPER">Paper Trading</option>
                              <option value="LIVE">Live Trading</option>
                            </select>
                          </div>
                          {Object.entries(strategy.parameters).map(([key, param]) => (
                            <div key={key} className="space-y-1">
                              <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">
                                {param.label}
                              </label>
                              <input
                                type={param.type}
                                defaultValue={param.default}
                                onChange={(e) =>
                                  setStrategyParams(prev => ({
                                    ...prev,
                                    [strategy.id]: {
                                      ...(prev[strategy.id] || {}),
                                      [key]: e.target.value
                                    }
                                  }))
                                }
                                className="w-full bg-slate-900 border border-white/5 rounded-lg px-2 py-1 text-white text-[9px] focus:ring-1 focus:ring-indigo-500/50 outline-none"
                              />
                            </div>
                          ))}
                        </div>

                        {/* Subscribe Button */}
                        <button
                          onClick={() => subscribeToStrategy(strategy)}
                          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
                        >
                          <Plus className="w-3 h-3" />
                          Initialize
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
