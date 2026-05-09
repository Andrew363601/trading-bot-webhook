// components/MarketScanner.js
// Advanced market scanner with favorites, asset browser, and strategy discovery

import React, { useState, useEffect, useRef } from 'react';
import { useSupabaseClient } from '@supabase/auth-helpers-react';
import { 
  Search, Star, Settings, Play, Plus, ChevronDown, TrendingUp, TrendingDown,
  Zap, Lock, AlertCircle
} from 'lucide-react';

export default function MarketScanner() {
  const supabase = useSupabaseClient();
  const [activeTab, setActiveTab] = useState('FAVORITES'); // FAVORITES, BROWSE
  const [allAssets, setAllAssets] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedStrategyId, setExpandedStrategyId] = useState(null);
  const [strategyParams, setStrategyParams] = useState({});

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

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
      if (!token) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const { data: users } = await supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('user_id', session.user.id)
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
  }, [token]);

  // When asset selected, fetch applicable strategies
  useEffect(() => {
    const fetchStrategies = async () => {
      if (!selectedAsset || !token) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/get-strategies-for-asset?asset=${selectedAsset.name}`, {
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
    if (!token) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: users } = await supabase
        .from('tenant_users')
        .select('tenant_id')
        .eq('user_id', session.user.id)
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
          asset: selectedAsset.name,
          strategy: strategy.id,
          exchange: 'COINBASE',
          product_type: 'FUTURES',
          parameters: strategyParams[strategy.id] || strategy.parameters
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

  const filteredAssets = (activeTab === 'FAVORITES' 
    ? allAssets.filter(a => favorites.includes(a.id))
    : allAssets
  ).filter(a => a.id.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="bg-slate-900/30 border border-white/5 rounded-2xl p-6 space-y-6">
      {/* Tabs */}
      <div className="flex gap-4 border-b border-white/10">
        <button
          onClick={() => setActiveTab('FAVORITES')}
          className={`px-4 py-2 font-bold uppercase text-xs tracking-widest transition-colors ${
            activeTab === 'FAVORITES'
              ? 'text-indigo-400 border-b-2 border-indigo-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Star className="w-4 h-4 inline mr-2" />
          Favorites
        </button>
        <button
          onClick={() => setActiveTab('BROWSE')}
          className={`px-4 py-2 font-bold uppercase text-xs tracking-widest transition-colors ${
            activeTab === 'BROWSE'
              ? 'text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <Search className="w-4 h-4 inline mr-2" />
          Browse All
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
        <input
          type="text"
          placeholder="Search assets..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-slate-950 border border-white/5 rounded-xl pl-10 pr-4 py-2 text-white text-sm placeholder-slate-600 focus:ring-2 focus:ring-indigo-500/50 outline-none"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Asset List */}
        <div className="lg:col-span-1 space-y-2 max-h-96 overflow-y-auto">
          {filteredAssets.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              No {activeTab === 'FAVORITES' ? 'favorite' : ''} assets found
            </div>
          ) : (
            filteredAssets.map(asset => (
              <button
                key={asset.id}
                onClick={() => {
                  setSelectedAsset(asset);
                  setStrategyParams({});
                }}
                className={`w-full text-left px-4 py-3 rounded-lg transition-all border ${
                  selectedAsset?.id === asset.id
                    ? 'bg-indigo-500/20 border-indigo-500/50'
                    : 'bg-slate-950 border-white/5 hover:border-white/10'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-white">{asset.id}</div>
                    <div className="text-xs text-slate-400">${asset.price?.toFixed(2)}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(asset.id);
                    }}
                    className={`transition-colors ${
                      favorites.includes(asset.id)
                        ? 'text-yellow-400'
                        : 'text-slate-600 hover:text-slate-400'
                    }`}
                  >
                    <Star className="w-4 h-4" fill="currentColor" />
                  </button>
                </div>
                <div className={`text-xs mt-1 flex items-center gap-1 ${
                  asset.price_percentage_change_24h >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {asset.price_percentage_change_24h >= 0 ? (
                    <TrendingUp className="w-3 h-3" />
                  ) : (
                    <TrendingDown className="w-3 h-3" />
                  )}
                  {asset.price_percentage_change_24h?.toFixed(2)}%
                </div>
              </button>
            ))
          )}
        </div>

        {/* Strategy Discovery */}
        <div className="lg:col-span-2">
          {!selectedAsset ? (
            <div className="flex flex-col items-center justify-center h-full py-12 text-slate-500">
              <Search className="w-12 h-12 mb-4 opacity-50" />
              <p className="font-bold">Select an asset to view available strategies</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-4">
                <h3 className="font-bold text-white mb-2">Strategies for {selectedAsset.id}</h3>
                <p className="text-xs text-slate-400">
                  Click to view parameters and subscribe
                </p>
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                </div>
              ) : availableStrategies.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  No strategies available for this asset
                </div>
              ) : (
                availableStrategies.map(strategy => (
                  <div
                    key={strategy.id}
                    className="bg-slate-950 border border-white/5 rounded-lg p-4 space-y-3"
                  >
                    <button
                      onClick={() => setExpandedStrategyId(
                        expandedStrategyId === strategy.id ? null : strategy.id
                      )}
                      className="w-full flex justify-between items-center hover:opacity-80 transition-opacity"
                    >
                      <div className="text-left">
                        <h4 className="font-bold text-white">{strategy.name}</h4>
                        <p className="text-xs text-slate-400">{strategy.description}</p>
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 text-slate-400 transition-transform ${
                          expandedStrategyId === strategy.id ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {expandedStrategyId === strategy.id && (
                      <div className="space-y-3 border-t border-white/5 pt-3">
                        {/* Parameters */}
                        <div className="grid grid-cols-2 gap-3">
                          {Object.entries(strategy.parameters).map(([key, param]) => (
                            <div key={key} className="space-y-1">
                              <label className="text-xs font-bold text-slate-400 uppercase">
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
                                className="w-full bg-slate-900 border border-white/5 rounded px-2 py-1 text-white text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none"
                              />
                            </div>
                          ))}
                        </div>

                        {/* Subscribe Button */}
                        <button
                          onClick={() => subscribeToStrategy(strategy)}
                          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                          <Plus className="w-4 h-4" />
                          Subscribe to {strategy.name}
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
