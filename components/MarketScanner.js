// components/MarketScanner.js
// Advanced market scanner with favorites, asset browser, and strategy discovery

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { 
  Search, Star, Settings, Play, Plus, ChevronDown, TrendingUp, TrendingDown,
  Zap, Lock, AlertCircle
} from 'lucide-react';

export default function MarketScanner({ onSelectAsset, currentAsset, activeStrategies = [] }) {
  const supabase = useSupabaseClient();
  const session = useSession();
  const token = session?.access_token;

  const [activeTab, setActiveTab] = useState('FAVORITES'); // FAVORITES, BROWSE, ACTIVE_STRATEGIES, PERPS, FUTURES
  const [allAssets, setAllAssets] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedStrategyId, setExpandedStrategyId] = useState(null);
  const [strategyParams, setStrategyParams] = useState({});
  const [executionMode, setExecutionMode] = useState('PAPER'); // PAPER or LIVE
  const [favoritesLoading, setFavoritesLoading] = useState({}); // Track individual favorite toggle states
  const [tenantId, setTenantId] = useState(null); // Cache tenant_id to avoid repeated queries
  const tabBarRef = useRef(null); // Ref for mobile touch-drag scrolling on tab bar
  const tabDragState = useRef({ isDragging: false, startX: 0, scrollLeft: 0 });

  // 🟢 MOBILE TAB DRAG: Touch handlers for smooth swipe-to-scroll on the tab bar
  const handleTabTouchStart = useCallback((e) => {
    const container = tabBarRef.current;
    if (!container) return;
    tabDragState.current.isDragging = true;
    tabDragState.current.startX = e.touches[0].pageX - container.offsetLeft;
    tabDragState.current.scrollLeft = container.scrollLeft;
  }, []);

  const handleTabTouchMove = useCallback((e) => {
    if (!tabDragState.current.isDragging) return;
    e.preventDefault();
    const container = tabBarRef.current;
    if (!container) return;
    const x = e.touches[0].pageX - container.offsetLeft;
    const walk = (x - tabDragState.current.startX) * 1.5; // Speed multiplier
    container.scrollLeft = tabDragState.current.scrollLeft - walk;
  }, []);

  const handleTabTouchEnd = useCallback(() => {
    tabDragState.current.isDragging = false;
  }, []);

  // Helper to normalize asset symbols for consistent comparison
  const normalizeAssetSymbol = (symbol) => {
    if (!symbol) return '';
    return symbol.replace(/(-PERP-INTX|-CDE|-PERP|-USD|-USDT)/g, '').toUpperCase();
  };

  // Sync selectedAsset with currentAsset if provided
  useEffect(() => {
    if (currentAsset && (!selectedAsset || normalizeAssetSymbol(selectedAsset.id) !== normalizeAssetSymbol(currentAsset))) {
        const asset = allAssets.find(a => normalizeAssetSymbol(a.id) === normalizeAssetSymbol(currentAsset));
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

  // Load tenant_id once and cache it
  useEffect(() => {
    const loadTenantId = async () => {
      if (!token || !session?.user?.id) return;
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
  }, [token, session, supabase]);

  // Load favorites from DB
  const loadFavorites = useCallback(async () => {
    if (!token || !tenantId) return;
    try {
      const { data: favAssets, error } = await supabase
        .from('favorite_assets')
        .select('asset')
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('Failed to load favorites from DB:', error);
        return;
      }
      setFavorites((favAssets || []).map(f => f.asset));
      console.log('[DEBUG] Favorites loaded:', (favAssets || []).map(f => f.asset));
    } catch (err) {
      console.error('Failed to load favorites:', err);
    }
  }, [token, tenantId, supabase]);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

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
    if (!token || !tenantId) return;
    setFavoritesLoading(prev => ({ ...prev, [assetName]: true }));
    try {
      if (favorites.includes(assetName)) {
        // Delete favorite
        const { error } = await supabase
          .from('favorite_assets')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('asset', assetName);

        if (error) {
          console.error('Failed to remove favorite:', error);
          alert(`❌ Failed to remove favorite: ${error.message}`);
        } else {
          console.log(`[DEBUG] Removed ${assetName} from favorites`);
          // Reload favorites from DB to ensure consistency
          await loadFavorites();
        }
      } else {
        // Add favorite
        const { data, error } = await supabase
          .from('favorite_assets')
          .insert([{ tenant_id: tenantId, asset: assetName }])
          .select();

        if (error) {
          console.error('Failed to add favorite:', error);
          alert(`❌ Failed to add favorite: ${error.message}`);
        } else {
          console.log(`[DEBUG] Added ${assetName} to favorites`, data);
          // Reload favorites from DB to ensure consistency
          await loadFavorites();
        }
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      alert('❌ Failed to toggle favorite');
    } finally {
      setFavoritesLoading(prev => ({ ...prev, [assetName]: false }));
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
            execution_mode: executionMode // Inject execution mode
          }
        })
      });

      if (res.ok) {
        alert(`✅ Subscribed to ${strategy.name} for ${selectedAsset.id}`);
        setStrategyParams({});
        // Call onSelectAsset if provided to refresh parent state
        if (onSelectAsset) onSelectAsset(selectedAsset.id);
      } else {
        const errorData = await res.json();
        alert(`❌ ${errorData.error || 'Failed to subscribe'}`);
      }
    } catch (err) {
      console.error('Failed to subscribe:', err);
      alert('Failed to subscribe to strategy');
    }
  };

  const filteredAssets = allAssets.filter(a => {
    const normalizedId = normalizeAssetSymbol(a.id);
    // 1. Tab filtering
    if (activeTab === 'FAVORITES' && !favorites.includes(a.id)) return false;
    if (activeTab === 'ACTIVE_STRATEGIES') {
      const assetHasActiveStrategy = activeStrategies.some(s => 
        normalizeAssetSymbol(s.asset) === normalizedId && s.is_active === true
      );
      if (!assetHasActiveStrategy) return false;
    }
    if (activeTab === 'PERPS' && !a.id.includes('PERP')) return false;
    if (activeTab === 'FUTURES' && !a.id.includes('-CDE')) return false;
    // 2. Search filtering (using normalized ID)
    if (searchTerm && !normalizedId.includes(searchTerm.toUpperCase())) return false;
    return true;
  });

  return (
    <div className="bg-slate-950/50 rounded-2xl p-3 space-y-4 max-h-[500px] overflow-y-auto custom-scrollbar">
      {/* Tabs — swipeable on mobile, full-width on desktop */}
      <div 
        ref={tabBarRef}
        onTouchStart={handleTabTouchStart}
        onTouchMove={handleTabTouchMove}
        onTouchEnd={handleTabTouchEnd}
        className="flex gap-4 border-b border-white/10 overflow-x-auto md:overflow-x-visible no-scrollbar justify-start md:justify-between min-w-max md:min-w-0 md:w-full cursor-grab active:cursor-grabbing"
      >
        <button
          onClick={() => setActiveTab('FAVORITES')}
          className={`px-3 py-2 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'FAVORITES'
              ? 'text-indigo-400 border-b-2 border-indigo-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Star className="w-3 h-3 inline mr-1" />
          Favs
        </button>
        <button
          onClick={() => setActiveTab('ACTIVE_STRATEGIES')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'ACTIVE_STRATEGIES'
              ? 'text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Zap className="w-3 h-3 inline mr-1" />
          My Strategies
        </button>
        <button
          onClick={() => setActiveTab('BROWSE')}
          className={`px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'BROWSE'
              ? 'text-cyan-400 border-b-2 border-cyan-400'
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
                    disabled={favoritesLoading[asset.id]}
                    className={`transition-colors p-1 ${
                      favoritesLoading[asset.id]
                        ? 'opacity-50 cursor-not-allowed'
                        : (favorites.includes(asset.id)
                          ? 'text-yellow-400'
                          : 'text-slate-700 hover:text-slate-500')
                    }`}
                  >
                    <Star className={`w-3 h-3 ${favoritesLoading[asset.id] ? 'animate-spin' : ''}`} fill={favorites.includes(asset.id) ? "currentColor" : "none"} />
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
