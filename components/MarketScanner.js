// components/MarketScanner.js
// Advanced market scanner with favorites, asset browser, and strategy discovery

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import { 
  Search, Star, Settings, Play, Plus, ChevronDown, TrendingUp, TrendingDown,
  Zap, Lock, AlertCircle
} from 'lucide-react';

// 🟢 PUSH AM64 — venue identity + copy. ONE map drives the venue accent color
// (--acc CSS custom property on the panel root), the sync/empty copy, and the
// venue label. Accents are SCOPED to this component (AM65 global design language
// is a separate push — no global theme change).
const VENUE_META = {
  coinbase: {
    label: 'Coinbase',
    accent: '#0B6BFF',
    sync: 'Syncing with Coinbase...',
    matrixName: 'Coinbase INTX matrix',
  },
  // 🟢 AM68 — the US-futures rail is MANUAL-only in the Pro UI (KDUS/Bitnomial via
  // NinjaTrader Clearing); Kraken exposes NO API for it. Label carries the truth.
  kraken: {
    label: 'Kraken US (Bitnomial · manual)',
    accent: '#FF8A3C',
    sync: 'Syncing with Kraken US (Bitnomial)...',
    matrixName: 'Bitnomial US matrix',
  },
  krakenfutures: {
    label: 'Kraken Futures',
    accent: '#7C5CFF',
    sync: 'Syncing with Kraken Futures...',
    matrixName: 'Kraken Futures matrix',
  },
};

// 🟢 PUSH AM64 — notional preview math. THE formula (stated identically in
// pages/studio.js — one formula, two render sites). qty × contract_size × price,
// formatted with Intl.NumberFormat USD. Returns null when the price is absent/0 —
// the caller HIDES the line (never fakes it).
function computeNotional(qty, contractSize, price) {
  const q = parseFloat(qty);
  const cs = contractSize != null ? parseFloat(contractSize) : 1;
  const px = parseFloat(price);
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(px) || px <= 0) return null;
  const notional = q * (Number.isFinite(cs) && cs > 0 ? cs : 1) * px;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(notional);
}

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
  const [conflictModal, setConflictModal] = useState(null); // { asset, activeStrategy, requestedStrategy, strategy }
  const [subscribing, setSubscribing] = useState(false); // Prevent double-submits during replace
  const [liveWarning, setLiveWarning] = useState(null); // { reason, strategy } — LIVE eligibility popup
  const [hasCoinbaseKeys, setHasCoinbaseKeys] = useState(null); // null = unknown, true/false once checked
  // 🟢 PUSH AM64 — KRF sibling of hasCoinbaseKeys. Same vault read pattern, same
  // UPPERCASE literal convention (secrets-manager normalizes with toUpperCase on
  // BOTH write and read). The asymmetry with lowercase routing columns is BY DESIGN
  // — do NOT unify (see migration 061 / push3 gate).
  const [hasKrakenFuturesKeys, setHasKrakenFuturesKeys] = useState(null); // null = unknown
  const [tenantId, setTenantId] = useState(null); // Cache tenant_id to avoid repeated queries
  // 🟢 PUSH AM64 — inline toast (replaces native alert()). { kind: 'error'|'success', text }
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((kind, text) => {
    setToast({ kind, text });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);
  // 🟢 PUSH AM63 (Push 5) — ONE venue selector drives the WHOLE matrix. Values are
  // the lowercase routing literals ('coinbase' | 'kraken' | 'krakenfutures').
  const [venue, setVenue] = useState('coinbase');
  // Last venue we fetched (per-venue cache). Replaces the once-per-session boolean.
  const fetchedVenueRef = useRef(null);
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
    let base = String(symbol).toUpperCase().trim();
    base = base.replace(/(-PERP-INTX|-PERP|-INTX|-CDE|-USDT|-USDC|-USD)/g, '');
    base = base.split('-')[0];
    return base;
  };

  // Sync selectedAsset with currentAsset if provided
  useEffect(() => {
    if (currentAsset && (!selectedAsset || normalizeAssetSymbol(selectedAsset.id) !== normalizeAssetSymbol(currentAsset))) {
        const asset = allAssets.find(a => normalizeAssetSymbol(a.id) === normalizeAssetSymbol(currentAsset));
        if (asset) setSelectedAsset(asset);
    }
  }, [currentAsset, allAssets, selectedAsset]);

  // Fetch all available FUTURES assets for the CURRENT venue.
  // 🟢 PUSH AM63 (Push 5) — venue-keyed fetch with a stale-race guard (mirrors the
  // Studio pattern). A venue swap invalidates the previous matrix: we clear the
  // selection + favorites view so a Coinbase id can NEVER be carried into a Kraken
  // menu (and vice versa).
  useEffect(() => {
    const fetchAssets = async () => {
      if (!token) return;
      const v = venue; // capture BEFORE await (stale-race guard)
      if (fetchedVenueRef.current === v) return; // already fetched this venue
      fetchedVenueRef.current = v;
      // Invalidate the prior venue's matrix the moment the venue changes.
      setAllAssets([]);
      setSelectedAsset(null);
      setAvailableStrategies([]);
      try {
        const res = await fetch(`/api/available-assets?exchange=${v}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        // A fast double-swap must not land the previous venue's payload.
        if (fetchedVenueRef.current !== v) return;
        setAllAssets(data.products || []);
      } catch (err) {
        console.error('Failed to fetch assets:', err);
        if (fetchedVenueRef.current === v) fetchedVenueRef.current = null; // allow retry
      }
    };
    fetchAssets();
  }, [token, venue]);

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

  // Load favorites from DB — scoped to the CURRENT venue (migration 062).
  const loadFavorites = useCallback(async () => {
    if (!token || !tenantId) return;
    try {
      const { data: favAssets, error } = await supabase
        .from('favorite_assets')
        .select('asset')
        .eq('tenant_id', tenantId)
        .eq('venue', venue);

      if (error) {
        console.error('Failed to load favorites from DB:', error);
        return;
      }
      setFavorites((favAssets || []).map(f => f.asset));
      console.log('[DEBUG] Favorites loaded:', (favAssets || []).map(f => f.asset));
    } catch (err) {
      console.error('Failed to load favorites:', err);
    }
  }, [token, tenantId, supabase, venue]);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  // Check whether the tenant has Coinbase API keys configured (gates LIVE trading).
  useEffect(() => {
    const checkKeys = async () => {
      if (!tenantId) return;
      try {
        const { data } = await supabase
          .from('api_keys_vault')
          .select('id')
          .eq('tenant_id', tenantId)
          // VAULT reads match the UPPERCASE literal (secrets-manager normalizes
          // with exchange.toUpperCase() on BOTH write and read). ROUTING columns
          // (strategy_config/trade_logs) stay lowercase canonical — the asymmetry
          // is by design, do NOT unify.
          .eq('exchange', 'COINBASE')
          .eq('is_active', true)
          .maybeSingle();
        setHasCoinbaseKeys(!!data);
      } catch (e) {
        setHasCoinbaseKeys(false);
      }
    };
    checkKeys();
  }, [tenantId, supabase]);

  // 🟢 PUSH AM64 — Kraken Futures keys check (LIVE gate for the krakenfutures venue).
  // Same vault read pattern as the Coinbase check above; the venue literal is the
  // UPPERCASE 'KRAKENFUTURES' (vault convention — settings.js posts it uppercase;
  // secrets-manager normalizes with toUpperCase on read). Do NOT lowercase this.
  useEffect(() => {
    const checkKfKeys = async () => {
      if (!tenantId) return;
      try {
        const { data } = await supabase
          .from('api_keys_vault')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('exchange', 'KRAKENFUTURES')
          .eq('is_active', true)
          .maybeSingle();
        setHasKrakenFuturesKeys(!!data);
      } catch (e) {
        setHasKrakenFuturesKeys(false);
      }
    };
    checkKfKeys();
  }, [tenantId, supabase]);

  // Determine if an asset is a Coinbase CDE-approved future (only these may go LIVE).
  const isCDEAsset = (assetId) => (assetId || '').toString().toUpperCase().includes('-CDE');

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
        // Delete favorite (scoped to the CURRENT venue — migration 062).
        const { error } = await supabase
          .from('favorite_assets')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('asset', assetName)
          .eq('venue', venue);

        if (error) {
          console.error('Failed to remove favorite:', error);
          showToast('error', `Failed to remove favorite: ${error.message}`);
        } else {
          console.log(`[DEBUG] Removed ${assetName} from favorites`);
          // Reload favorites from DB to ensure consistency
          await loadFavorites();
        }
      } else {
        // Add favorite (stamped with the CURRENT venue — migration 062).
        const { data, error } = await supabase
          .from('favorite_assets')
          .insert([{ tenant_id: tenantId, asset: assetName, venue }])
          .select();

        if (error) {
          console.error('Failed to add favorite:', error);
          showToast('error', `Failed to add favorite: ${error.message}`);
        } else {
          console.log(`[DEBUG] Added ${assetName} to favorites`, data);
          // Reload favorites from DB to ensure consistency
          await loadFavorites();
        }
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      showToast('error', 'Failed to toggle favorite');
    } finally {
      setFavoritesLoading(prev => ({ ...prev, [assetName]: false }));
    }
  };

  const subscribeToStrategy = async (strategy, forceReplace = false, liveConfirmed = false) => {
    if (!selectedAsset || !token) return;

    // 🔒 LIVE eligibility gate (popup warning) — 🟢 PUSH AM64: VENUE-AWARE. The
    // matrix mirrors the server gates (subscribe-strategy.js / deploy-strategy.js):
    //   coinbase       → CDE assets only + COINBASE keys (unchanged)
    //   krakenfutures  → KRAKENFUTURES vault row required (KRF LIVE lane shipped Push 7)
    //   kraken         → PAPER-only: no Kraken US-futures API exists (AM68 — the
    //                    KRF/DRV doors are international/geo-blocked; US API = Tradovate)
    // Server enforces this too; this is the friendly front-line warning.
    if (executionMode === 'LIVE' && !liveConfirmed) {
      if (venue === 'kraken') {
        setLiveWarning({
          strategy,
          blocking: true,
          reason: 'Kraken has no US-futures API: the KRF/DRV doors serve the international platform (geo-blocked for US accounts). US derivatives API = a Tradovate account (per Kraken). This venue stays PAPER-only.',
        });
        return;
      }
      if (venue === 'krakenfutures') {
        if (hasKrakenFuturesKeys === false) {
          setLiveWarning({
            strategy,
            blocking: true,
            reason: 'LIVE trading on Kraken Futures requires apiv3 keys. Add them in Settings → Exchange Provider (Kraken Futures) first, or switch to PAPER mode.',
          });
          return;
        }
        // Keys present (or unknown): require an explicit risk acknowledgement.
        setLiveWarning({
          strategy,
          blocking: false,
          reason: `You are about to deploy "${strategy.name || strategy.id}" on ${selectedAsset.id} (Kraken Futures) in LIVE mode. Real funds will be at risk. Continue?`,
        });
        return;
      }
      // coinbase (default): CDE assets only + COINBASE keys.
      if (!isCDEAsset(selectedAsset.id)) {
        setLiveWarning({
          strategy,
          blocking: true,
          reason: `${selectedAsset.id} is not a Coinbase CDE-approved future. LIVE trading is restricted to CDE derivatives only. Use PAPER mode for this asset.`,
        });
        return;
      }
      if (hasCoinbaseKeys === false) {
        setLiveWarning({
          strategy,
          blocking: true,
          reason: 'LIVE trading requires Coinbase API keys. Add them in Settings → API Keys first, or switch to PAPER mode to start simulated trading.',
        });
        return;
      }
      // CDE asset + keys present (or unknown): require an explicit risk acknowledgement.
      setLiveWarning({
        strategy,
        blocking: false,
        reason: `You are about to deploy "${strategy.name || strategy.id}" on ${selectedAsset.id} in LIVE mode. Real funds will be at risk. Continue?`,
      });
      return;
    }

    setSubscribing(true);
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
          exchange: venue,
          product_type: 'FUTURES',
          force_replace: forceReplace,
          parameters: {
            ...strategy.parameters,
            ...strategyParams[strategy.id],
            execution_mode: executionMode // Inject execution mode
          }
        })
      });

      if (res.ok) {
        setConflictModal(null);
        showToast('success', `Subscribed to ${strategy.name} for ${selectedAsset.id}`);
        setStrategyParams({});
        // Call onSelectAsset if provided to refresh parent state
        if (onSelectAsset) onSelectAsset(selectedAsset.id);
      } else if (res.status === 409) {
        // 🛡️ One-active-strategy-per-asset conflict: surface a confirmation popup
        // rather than silently overriding. Protects against conflicting orders.
        const conflict = await res.json();
        setConflictModal({
          asset: conflict.asset || selectedAsset.id,
          activeStrategy: conflict.active_strategy,
          requestedStrategy: strategy.name || strategy.id,
          strategy, // keep the full object so we can re-submit with force_replace
        });
      } else {
        const errorData = await res.json();
        showToast('error', errorData.error || 'Failed to subscribe');
      }
    } catch (err) {
      console.error('Failed to subscribe:', err);
      showToast('error', 'Failed to subscribe to strategy');
    } finally {
      setSubscribing(false);
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
    // 🟢 PUSH AM63 (Push 5) — venue-aware tabs. PERPS matches any venue's perp id
    // (`-PERP-` covers -PERP-INTX / -PERP-KRX- / -PERP-KRF). FUTURES (-CDE) is a
    // Coinbase-only product family — on a kraken venue the tab is empty (honest).
    if (activeTab === 'PERPS' && !a.id.includes('-PERP-')) return false;
    if (activeTab === 'FUTURES' && !a.id.includes('-CDE')) return false;
    // 2. Search filtering (using normalized ID)
    if (searchTerm && !normalizedId.includes(searchTerm.toUpperCase())) return false;
    return true;
  });

  return (
    /* 🛠️ Hard-fixed height on desktop so the panel never grows past what fits
       in the dropdown window. Mobile keeps a viewport-relative cap. Horizontal
       scrolling is locked off here — only the inner tab strip is allowed to pan
       horizontally, which fixes the "scrolling the bottom moves the FULL menu"
       bug. touchAction: pan-y tells mobile browsers we only want vertical pan
       on this surface, so the OS won't translate horizontal swipes into a
       full-panel drag. */
    <div
      className="bg-slate-950/50 rounded-2xl p-3 space-y-4 max-h-[calc(100vh-180px)] md:max-h-[520px] md:h-[520px] overflow-y-auto overflow-x-hidden custom-scrollbar"
      style={{ touchAction: 'pan-y', '--acc': VENUE_META[venue]?.accent || VENUE_META.coinbase.accent }}
    >
      {/* 🟢 PUSH AM63 (Push 5) — VENUE SELECT FIRST. Swapping the venue repopulates
          the WHOLE matrix (assets, favorites, selection, deploy panel). Values are
          the lowercase routing literals.
          🟢 PUSH AM64 — preview-ratified 3-button venue row with per-venue accent
          (VENUE_META). The accent rides a --acc CSS custom property on the panel
          root (below); selected-row wash, tab underline, venue-dot, notional accent
          and the primary button consume it. SCOPED to this component. */}
      <div className="flex items-center gap-1.5">
        {Object.entries(VENUE_META).map(([key, meta]) => (
          <button
            key={key}
            onClick={() => setVenue(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors ${
              venue === key
                ? 'text-white'
                : 'border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            style={venue === key ? { borderColor: meta.accent, background: `${meta.accent}22` } : undefined}
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: venue === key ? meta.accent : undefined, backgroundColor: venue === key ? meta.accent : '#5F6570', opacity: venue === key ? 1 : 0.5 }}
            />
            {meta.label}
          </button>
        ))}
      </div>

      {/* Tabs.
          • Mobile: a draggable strip — only the tabs move (drag the bar below to scroll
            through them); no page-level horizontal scrollbar.
          • Desktop: locked, all tabs visible at once (panel widened to fit). */}
      <div 
        ref={tabBarRef}
        onTouchStart={handleTabTouchStart}
        onTouchMove={handleTabTouchMove}
        onTouchEnd={handleTabTouchEnd}
        // Mobile: the strip itself owns horizontal scroll. It must be width-
        // constrained (w-full) so overflow-x-auto actually clips + scrolls, and
        // touchAction:pan-x lets the OS translate horizontal swipes into native
        // scroll here (the parent uses pan-y). On desktop all tabs fit at once.
        style={{ touchAction: 'pan-x' }}
        className="flex gap-3 md:gap-1 border-b border-white/10 w-full overflow-x-auto md:overflow-x-visible no-scrollbar justify-start md:justify-between md:w-full cursor-grab active:cursor-grabbing select-none"
      >
        <button
          onClick={() => setActiveTab('FAVORITES')}
          className={`shrink-0 px-3 py-2 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
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
          className={`shrink-0 px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
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
          className={`shrink-0 px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
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
          className={`shrink-0 px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
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
          className={`shrink-0 px-3 py-1.5 font-bold uppercase text-[10px] tracking-widest transition-colors whitespace-nowrap ${
            activeTab === 'FUTURES'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <TrendingDown className="w-3 h-3 inline mr-1" />
          Futures
        </button>
      </div>

      {/* Mobile-only drag bar: drag this to scroll the tab strip above.
          Hidden on desktop where all tabs are already visible. */}
      <button
        type="button"
        aria-label="Drag to scroll tabs"
        onTouchStart={handleTabTouchStart}
        onTouchMove={handleTabTouchMove}
        onTouchEnd={handleTabTouchEnd}
        className="md:hidden -mt-3 mx-auto flex h-4 w-24 items-center justify-center cursor-grab active:cursor-grabbing touch-none"
      >
        <span className="h-1 w-16 rounded-full bg-white/15" />
      </button>

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
              {/* 🟢 PUSH AM64 — venue-aware copy (was Coinbase-hardcoded). */}
              <div className="animate-pulse text-[10px] font-black uppercase mb-2" style={{ color: 'var(--acc)' }}>
                {VENUE_META[venue]?.sync || VENUE_META.coinbase.sync}
              </div>
              <div className="text-slate-600 text-[8px] uppercase">
                Attempting to map {VENUE_META[venue]?.matrixName || VENUE_META.coinbase.matrixName}
              </div>
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="text-center py-4 text-[10px] text-slate-500 uppercase tracking-widest font-black">
              Empty {VENUE_META[venue]?.matrixName || 'Matrix'}
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
                    ? ''
                    : 'bg-slate-950/50 border-white/5 hover:border-white/10'
                }`}
                style={selectedAsset?.id === asset.id ? { borderColor: 'var(--acc)', background: 'color-mix(in srgb, var(--acc) 14%, transparent)' } : undefined}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-black text-[10px] text-white uppercase tracking-tighter">{asset.id}</div>
                    {/* 🟢 PUSH AM64 — KRX rows carry NO prices (specs payload) — render
                        an honest amber 'mark pending' chip instead of a fake $0.00.
                        Real prices arrive with the Push 8 market-data push. */}
                    {asset.price === 0 || asset.price == null ? (
                      <div className="text-[9px] font-mono text-amber-400">⏳ mark pending</div>
                    ) : (
                      <div className="text-[9px] text-slate-500 font-mono">${asset.price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    )}
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
        {/* 🟢 PUSH AM64 — INSTRUMENT CARD. Venue-native contract facts for the
            selected asset, rendered ABOVE the deploy matrix (it informs the deploy,
            it replaces nothing). Facts come from the enriched available-assets
            payload; any fact the venue does not provide renders '—' (honest-absent,
            never fabricated). The notional strip is live math bound to the qty the
            user is about to deploy with: qty × contract_size × price. */}
        {selectedAsset && (
          <div
            className="rounded-xl border p-3 space-y-2"
            style={{ borderColor: 'var(--acc)', background: 'color-mix(in srgb, var(--acc) 7%, transparent)' }}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--acc)' }} />
              <span className="font-black text-[10px] text-white uppercase tracking-tighter">{selectedAsset.id}</span>
              {selectedAsset.category && (
                <span className="text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded" style={{ color: 'var(--acc)', background: 'color-mix(in srgb, var(--acc) 14%, transparent)' }}>
                  {selectedAsset.category}
                </span>
              )}
              {selectedAsset.settlement_method && (
                <span className="text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded text-emerald-400 bg-emerald-500/10">
                  {selectedAsset.settlement_method}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-px bg-white/10 border border-white/10 rounded-lg overflow-hidden">
              {/* Contract */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Contract</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {selectedAsset.contract_size != null
                    ? `${selectedAsset.contract_size} ${selectedAsset.contract_size_unit || selectedAsset.base || ''}`.trim()
                    : '—'}
                </div>
              </div>
              {/* Tick */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Tick</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {selectedAsset.tick_size != null
                    ? selectedAsset.tick_size
                    : selectedAsset.price_increment != null
                      ? selectedAsset.price_increment
                      : selectedAsset.quote_increment != null
                        ? selectedAsset.quote_increment
                        : '—'}
                </div>
              </div>
              {/* Margin — venue-honest language */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Margin</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {venue === 'krakenfutures' && selectedAsset.initial_margin != null
                    ? `Initial ${(selectedAsset.initial_margin * 100).toFixed(1)}% · Maint ${selectedAsset.maintenance_margin != null ? `${(selectedAsset.maintenance_margin * 100).toFixed(1)}%` : '—'} (tier 1)`
                    : venue === 'kraken'
                      ? `Unit: ${selectedAsset.margin_unit || '—'}${selectedAsset.settlement_method ? ` · ${selectedAsset.settlement_method}` : ''}`
                      : selectedAsset.contract_size != null || selectedAsset.base_increment != null
                        ? `Contract ${selectedAsset.contract_size ?? '—'}${selectedAsset.base_increment != null ? ` · Incr ${selectedAsset.base_increment}` : ''}`
                        : '—'}
                </div>
              </div>
              {/* Limits */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Limits</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {selectedAsset.max_position_size != null
                    ? `Max pos ${Number(selectedAsset.max_position_size).toLocaleString()}`
                    : selectedAsset.max_order_quantity != null
                      ? `Max order ${Number(selectedAsset.max_order_quantity).toLocaleString()}`
                      : selectedAsset.max_market_base_size != null
                        ? `Max mkt ${Number(selectedAsset.max_market_base_size).toLocaleString()}`
                        : '—'}
                </div>
              </div>
              {/* Funding — KRF/KRX only; coinbase absent → '—' */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Funding</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {selectedAsset.funding_interval_hours != null
                    ? `${selectedAsset.funding_interval_hours}h${
                        selectedAsset.funding_rate_upper_bound != null && selectedAsset.funding_rate_lower_bound != null
                          ? ` ±${(selectedAsset.funding_rate_upper_bound * 100).toFixed(2)}%`
                          : selectedAsset.max_relative_funding_rate != null
                            ? ` cap ${(selectedAsset.max_relative_funding_rate * 100).toFixed(2)}%`
                            : ''
                      }`
                    : '—'}
                </div>
              </div>
              {/* Settlement / venue detail */}
              <div className="bg-slate-950 px-2 py-1.5">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Settlement</div>
                <div className="text-[10px] font-mono font-bold text-white">
                  {selectedAsset.price_quotation_unit || selectedAsset.contract_expiry_type || '—'}
                </div>
              </div>
            </div>
            {/* Notional preview strip — THE comprehension line. Hidden when the
                price is absent/0 (KRX) — never faked. Same formula as studio.js. */}
            {(() => {
              const notionalQty = strategyParams.__notional_qty__ ?? '10';
              const notional = computeNotional(notionalQty, selectedAsset.contract_size, selectedAsset.price);
              return (
                <div
                  className="flex items-center gap-2 mt-2 rounded-lg border border-dashed px-2 py-1.5"
                  style={{ borderColor: 'var(--acc)', background: 'color-mix(in srgb, var(--acc) 7%, transparent)' }}
                >
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={notionalQty}
                    onChange={(e) => setStrategyParams(prev => ({ ...prev, __notional_qty__: e.target.value }))}
                    className="w-16 bg-slate-950 border border-white/10 rounded px-1.5 py-1 text-[10px] font-mono text-white text-right outline-none"
                  />
                  <span className="text-[10px] font-mono font-bold" style={{ color: 'var(--acc)' }}>
                    {notional ? `≈ ${notional} notional` : 'qty × contract × mark'}
                  </span>
                  <span className="ml-auto text-[8px] font-mono text-slate-500">qty × contract × mark</span>
                </div>
              );
            })()}
          </div>
        )}

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

      {/* 🛡️ One-active-strategy-per-asset confirmation popup */}
      {conflictModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-5 w-full max-w-sm shadow-2xl shadow-[0_0_40px_rgba(245,158,11,0.25)]">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-black text-white uppercase tracking-wide">Active Strategy Conflict</h3>
                <p className="text-[10px] text-amber-300/80 font-bold uppercase tracking-widest">{conflictModal.asset}</p>
              </div>
            </div>
            <p className="text-slate-300 text-xs leading-relaxed mb-3">
              Only <span className="font-black text-white">one strategy</span> can be active per asset.
              Running two on the same asset can cause conflicting orders and unexpected closures
              that may blow up your account.
            </p>
            <p className="text-slate-400 text-xs leading-relaxed mb-5">
              Activating <span className="font-bold text-indigo-300">{conflictModal.requestedStrategy}</span> will
              deactivate <span className="font-bold text-red-300">{conflictModal.activeStrategy}</span> on {conflictModal.asset}.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConflictModal(null)}
                disabled={subscribing}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-black text-[10px] uppercase tracking-widest py-2.5 rounded-xl transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => subscribeToStrategy(conflictModal.strategy, true)}
                disabled={subscribing}
                className="flex-1 bg-amber-600 hover:bg-amber-500 text-white font-black text-[10px] uppercase tracking-widest py-2.5 rounded-xl transition-colors disabled:opacity-50"
              >
                {subscribing ? 'Replacing…' : 'Replace & Activate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🔒 LIVE trading eligibility / risk warning popup */}
      {liveWarning && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className={`bg-slate-900 border rounded-2xl p-5 w-full max-w-sm shadow-2xl ${liveWarning.blocking ? 'border-red-500/40 shadow-[0_0_40px_rgba(239,68,68,0.25)]' : 'border-amber-500/40 shadow-[0_0_40px_rgba(245,158,11,0.25)]'}`}>
            <div className="flex items-start gap-3 mb-4">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${liveWarning.blocking ? 'bg-red-500/15' : 'bg-amber-500/15'}`}>
                {liveWarning.blocking ? <Lock className="w-5 h-5 text-red-400" /> : <AlertCircle className="w-5 h-5 text-amber-400" />}
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-black text-white uppercase tracking-wide">
                  {liveWarning.blocking ? 'LIVE Trading Blocked' : 'Confirm LIVE Deployment'}
                </h3>
                <p className={`text-[10px] font-bold uppercase tracking-widest ${liveWarning.blocking ? 'text-red-300/80' : 'text-amber-300/80'}`}>{selectedAsset?.id}</p>
              </div>
            </div>
            <p className="text-slate-300 text-xs leading-relaxed mb-5">{liveWarning.reason}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setLiveWarning(null)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-black text-[10px] uppercase tracking-widest py-2.5 rounded-xl transition-colors"
              >
                {liveWarning.blocking ? 'Close' : 'Cancel'}
              </button>
              {!liveWarning.blocking && (
                <button
                  onClick={() => { const s = liveWarning.strategy; setLiveWarning(null); subscribeToStrategy(s, false, true); }}
                  disabled={subscribing}
                  className="flex-1 bg-red-600 hover:bg-red-500 text-white font-black text-[10px] uppercase tracking-widest py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  {subscribing ? 'Deploying…' : 'Deploy LIVE'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 🟢 PUSH AM64 — inline toast (replaces native alert()). Bottom-center,
          border-tinted by kind, auto-dismisses ~4s (timer in showToast). */}
      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[400] px-4 py-2.5 rounded-lg border shadow-2xl text-xs font-bold max-w-sm ${
            toast.kind === 'error'
              ? 'border-red-500/40 bg-slate-900 text-red-300'
              : 'border-emerald-500/40 bg-slate-900 text-emerald-300'
          }`}
          role="status"
        >
          {toast.kind === 'error' ? '✕ ' : '✓ '}{toast.text}
        </div>
      )}
    </div>
  );
}
