// HARD PUSH:

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSwipeable } from 'react-swipeable';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import Link from 'next/link'; 
import { createChart, CrosshairMode, CandlestickSeries, createSeriesMarkers, HistogramSeries } from 'lightweight-charts';
import { 
  Database, BarChart3, Cpu, Terminal as TerminalIcon, 
  Send, Activity, PieChart, Shield, Zap, TrendingUp, TrendingDown,
  Target, AlertTriangle, ArrowRight, RefreshCw, Layers, BrainCircuit,
  Settings, LogOut, Clock, Crosshair, ChevronRight, Menu, X, PlusCircle,
  Search, AlertOctagon, Eye, Minimize2, Maximize2, Power, ChevronDown, Sun, Moon
} from 'lucide-react';
import AuthGuard from '../components/AuthGuard';
import MarketScanner from '../components/MarketScanner';
import QuickStartGuide from '../components/QuickStartGuide';
import ChatNotification from '../components/ChatNotification';
import { getCoinbaseAffiliateLink } from '../lib/constants';

export default function Dashboard() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}

function DashboardContent() {
  const supabase = useSupabaseClient();
  const session = useSession();
  // Phase 3.4 test UX: local toggle to demonstrate prompts in UI without affecting production flow
  const [phase3Test, setPhase3Test] = useState(false);
  // Phase 3.4 UX prompts state
  const [phase3Pending, setPhase3Pending] = useState(null); // { mode: 'PAPER'|'LIVE', source: 'chat'|'ui', message?: string }
  const [theme, setTheme] = useState('dark'); // Default to dark mode

  // Theme persistence
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    } else {
      document.documentElement.classList.add('dark'); // Default to dark if no preference
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'dark' ? 'light' : 'dark'));
  };

  // Helper to normalize asset symbols for consistent comparison
  const normalizeAssetSymbol = useCallback((symbol) => {
    if (!symbol) return '';
    return symbol.replace(/(-PERP-INTX|-CDE|-PERP|-USD|-USDT)/g, '').toUpperCase();
  }, []);

  const [activeAsset, setActiveAsset] = useState('BTC-PERP-INTX');
  const [activeTab, setActiveTab] = useState('ANALYTICS');
  
  const [assetsList, setAssetsList] = useState([
    'BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX', 'DOGE-PERP-INTX',
    'LINK-PERP-INTX', 'AVAX-PERP-INTX', 'LTC-PERP-INTX', 'BCH-PERP-INTX'
  ]);
  
  const [livePrice, setLivePrice] = useState(0); 
  const [tradeLogs, setTradeLogs] = useState([]);
  const [debouncedTradeLogs, setDebouncedTradeLogs] = useState([]);

  // Debounce tradeLogs updates to stabilize chart markers
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedTradeLogs(tradeLogs);
    }, 200); // Debounce for 200ms
    return () => {
      clearTimeout(handler);
    };
  }, [tradeLogs]);
  const [activeStrategies, setActiveStrategies] = useState([]);
  const [scanStream, setScanStream] = useState([]); 
  const [portfolio, setPortfolio] = useState({ live: { balance: 0 }, paper: { balance: 5000, initial: 5000 } });
  const [loading, setLoading] = useState(true);
  const [tenantId, setTenantId] = useState(null); // Cache tenant_id for data filtering
  
  // Header metrics state for reactive updates
  const [latestScan, setLatestScan] = useState(null);
  const [bids, setBids] = useState(0);
  const [asks, setAsks] = useState(0);
  const [cvd, setCvd] = useState(0);
  const [totalLiquidity, setTotalLiquidity] = useState(0);
  const [targetPercent, setTargetPercent] = useState(50);
  
  const [livePositions, setLivePositions] = useState([]);
  const [liveOrders, setLiveOrders] = useState([]);
  const [isChartMaximized, setIsChartMaximized] = useState(false);
  const [isDefconActive, setIsDefconActive] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // Profile settings state
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileFullName, setProfileFullName] = useState('');
  const [profileApiKey, setProfileApiKey] = useState('');
  const [profileApiSecret, setProfileApiSecret] = useState('');
  const [profileWebhookUrl, setProfileWebhookUrl] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');

  // Risk profile preview state (for profile modal)
  const [riskPreview, setRiskPreview] = useState(null);

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const onboardingSteps = [
    { title: 'Activate Your First Strategy', desc: 'Select an asset from the market scanner, then choose a strategy and toggle it to PAPER mode to start simulated trading.', target: 'strategy-matrix' },
    { title: 'Connect Coinbase', desc: 'Create a Coinbase account to fund your live trading. Click the button below to get started.', target: 'coinbase', action: true, actionLabel: 'Create Coinbase Account', actionUrl: getCoinbaseAffiliateLink('onboarding') },
    { title: 'Add Your API Keys', desc: 'Go to Profile Settings to add your Coinbase API keys. Use "Trade Only" permissions for security.', target: 'profile' },
    { title: 'Connect Discord', desc: 'Add your Discord webhook URL in Profile Settings to receive real-time trade alerts.', target: 'discord' },
  ];

  // Risk assessment & quick start state
  const [riskAssessmentComplete, setRiskAssessmentComplete] = useState(true); // default true, set after fetch
  const [quickStartDismissed, setQuickStartDismissed] = useState(true);
  const [onboardingMessageSent, setOnboardingMessageSent] = useState(false);
  const quickStartRef = useRef(null);

  // Trial grace period banner
  const [graceBanner, setGraceBanner] = useState(null); // { daysLeft: number } or null

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const seriesMarkersRef = useRef(null); 
  const priceLinesRef = useRef([]);
  const volumeLinesRef = useRef([]);
  const [chartTimeframe, setChartTimeframe] = useState('1m');
  const [showMarkers, setShowMarkers] = useState(true);
  const [showPriceLines, setShowPriceLines] = useState(true);

  const isLoadingOlderRef = useRef(false);
  const allChartDataRef = useRef([]);
  const earliestFetchedTimeRef = useRef(null);

  const [localInput, setLocalInput] = useState('');

  // Trade log filter state
  const [logStrategyFilter, setLogStrategyFilter] = useState('ALL');
  const [logStatusFilter, setLogStatusFilter] = useState('ALL');
  const [sessionLogAgentFilter, setSessionLogAgentFilter] = useState('ALL'); // New state for session log filter

  // Active matrix navigation state
  const [currentStrategyIndex, setCurrentStrategyIndex] = useState(0);
  const [strategyMetadata, setStrategyMetadata] = useState([]);
  const [sessionLogs, setSessionLogs] = useState([]);

  // Strategy management state for edit modal
  const [editingStrategy, setEditingStrategy] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingParameters, setEditingParameters] = useState({});
  const [editingExecutionMode, setEditingExecutionMode] = useState('PAPER');

  const normalizeParametersForEditor = useCallback((params) => {
    if (!params) return {};

    // Reverse timeframe mapping: Coinbase API format → short display format
    const coinbaseToShort = {
      'ONE_MINUTE': '1m', 'FIVE_MINUTE': '5m', 'FIFTEEN_MINUTE': '15m',
      'THIRTY_MINUTE': '30m', 'ONE_HOUR': '1h', 'TWO_HOUR': '2h',
      'FOUR_HOUR': '4h', 'SIX_HOUR': '6h', 'ONE_DAY': '1d',
      '1HR': '1h', '5MIN': '5m', '15MIN': '15m', '30MIN': '30m'
    };

    const normalized = {};
    for (const key in params) {
      const value = params[key];
      if (typeof value === 'object' && value !== null && 'default' in value && 'type' in value) {
        normalized[key] = value;
      } else {
        let displayValue = value;
        // Convert Coinbase timeframe format to short display format for macro_tf and trigger_tf
        if ((key === 'macro_tf' || key === 'trigger_tf') && coinbaseToShort[displayValue?.toUpperCase()]) {
          displayValue = coinbaseToShort[displayValue.toUpperCase()];
        }
        normalized[key] = {
          default: displayValue,
          type: typeof value === 'number' ? 'number' : 'text',
          label: key.replace(/_/g, ' ').toUpperCase(),
          ...(key.includes('leverage') && { min: 1, max: 10 }),
          ...(key.includes('quantity') && { min: 0.001, max: 100 }),
          ...(key.includes('stop_loss_pct') && { min: 0.1, max: 20 }),
          ...(key.includes('take_profit_pct') && { min: 0.1, max: 50 }),
        };
      }
    }
    return normalized;
  }, []);

  const flattenParametersForSave = useCallback((params) => {
    if (!params) return {};

    // Timeframe mapping: short format → Coinbase API format
    const tfToCoinbase = {
      '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE',
      '30m': 'THIRTY_MINUTE', '1h': 'ONE_HOUR', '2h': 'TWO_HOUR',
      '4h': 'FOUR_HOUR', '6h': 'SIX_HOUR', '1d': 'ONE_DAY',
      '1hr': 'ONE_HOUR', '5min': 'FIVE_MINUTE', '15min': 'FIFTEEN_MINUTE',
      '30min': 'THIRTY_MINUTE', '2hr': 'TWO_HOUR', '4hr': 'FOUR_HOUR',
      '6hr': 'SIX_HOUR'
    };

    const flattened = {};
    for (const key in params) {
      const value = params[key];
      if (typeof value === 'object' && value !== null && ('default' in value || 'value' in value)) {
        let rawValue = value.value !== undefined ? value.value : value.default;
        // Convert short timeframe formats to Coinbase format for macro_tf and trigger_tf
        if ((key === 'macro_tf' || key === 'trigger_tf') && tfToCoinbase[rawValue?.toLowerCase()]) {
          rawValue = tfToCoinbase[rawValue.toLowerCase()];
        }
        flattened[key] = rawValue;
      } else {
        flattened[key] = value;
      }
    }
    return flattened;
  }, []);

  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sdkError, setSdkError] = useState(null);

  const append = useCallback(async (message) => {
    if (isLoading) return;
    setIsLoading(true);
    setSdkError(null);
    
    const updatedMessages = [...messages, message];
    setMessages(updatedMessages);
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : '',
        },
        body: JSON.stringify({ messages: updatedMessages }),
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Chat API returned ${res.status}`);
      }
      
      // Handle streaming response (raw text chunks from textStream)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let parsedContent = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parsedContent += decoder.decode(value, { stream: true });
      }
      
      const assistantMessage = { 
        role: 'assistant', 
        content: parsedContent || 'No response generated', 
        id: Date.now().toString() 
      };
      
      // Only add non-empty responses to conversation history
      if (parsedContent && parsedContent !== 'No response generated') {
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        console.warn("[CHAT DEBUG] Empty response received, not adding to conversation history.");
      }
    } catch (err) {
      console.error("[NEXUS AGENT FATAL]:", err);
      setSdkError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, session?.access_token]);

  // Persist messages to session storage to avoid losing them on reload.
  // 🔒 SECURITY: Strip sensitive patterns (API keys, secrets) before persisting.
  useEffect(() => {
    if (messages.length > 0) {
      const sensitivePatterns = [
        /-----BEGIN/g,
        /organizations\//gi,
        /api[_ ]?key/i,
        /api[_ ]?secret/i,
        /private[_ ]?key/i
      ];
      const sanitizedMessages = messages.map(m => {
        if (!m.content || typeof m.content !== 'string') return m;
        let sanitized = m.content;
        for (const pattern of sensitivePatterns) {
          if (pattern.test(sanitized)) {
            sanitized = '[🔒 Sensitive credentials redacted for security]';
            break;
          }
        }
        return { ...m, content: sanitized };
      });
      sessionStorage.setItem('nexus_chat_history', JSON.stringify(sanitizedMessages));
    }
  }, [messages]);

  useEffect(() => {
    const saved = sessionStorage.getItem('nexus_chat_history');
    if (saved && messages.length === 0) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter out any "No response generated" messages from history
          const cleanMessages = parsed.filter(m => 
            m.role !== 'assistant' || (m.content && m.content !== 'No response generated')
          );
          setMessages(cleanMessages);
        }
      } catch (e) {
        console.error("[NEXUS DEBUG] Failed to load chat history:", e);
      }
    }
  }, [setMessages, messages.length]);

  const chatEndRef = useRef(null);

  useEffect(() => {
      const checkDefconTime = () => {
          const now = new Date();
          const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
          const centralHour = parseInt(formatter.format(now), 10);
          setIsDefconActive(centralHour === 14); 
      };
      
      checkDefconTime();
      const defconInterval = setInterval(checkDefconTime, 60000); 
      return () => clearInterval(defconInterval);
  }, []);

  // Load tenant_id on mount for data filtering
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
        if (users?.tenant_id) {
          setTenantId(users.tenant_id);
          console.log('[DEBUG] Loaded tenant_id for data filtering');

          // Fetch onboarding state
          try {
            const { data: settings } = await supabase
              .from('tenant_settings')
              .select('risk_assessment_complete, quick_start_dismissed')
              .eq('tenant_id', users.tenant_id)
              .single();

            if (settings) {
              setRiskAssessmentComplete(settings.risk_assessment_complete !== false);
              setQuickStartDismissed(settings.quick_start_dismissed === true);
            }
          } catch (err) {
            console.error('[ONBOARDING] Failed to fetch settings:', err);
          }
        }
      } catch (err) {
        console.error('Failed to load tenant_id:', err);
      }
    };
    loadTenantId();
  }, [session?.user?.id, supabase]);

  // Onboarding check: show tour for first 5 days
  useEffect(() => {
    if (!session?.user?.id) return;
    const checkOnboarding = async () => {
      const completed = localStorage.getItem('nexus_onboarding_completed');
      if (completed === 'true') return;

      // Check account age from tenants table
      const { data: userData } = await supabase
        .from('tenant_users')
        .select('tenants(created_at)')
        .eq('auth_user_id', session.user.id)
        .single();

      if (userData?.tenants?.created_at) {
        const created = new Date(userData.tenants.created_at);
        const now = new Date();
        const daysSinceCreation = (now - created) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation <= 5) {
          setShowOnboarding(true);
          setOnboardingStep(0);
        }
      }
    };
    checkOnboarding();
  }, [session?.user?.id, supabase]);

  // Auto-prompt onboarding message in chat if risk assessment not complete
  useEffect(() => {
    if (!tenantId || riskAssessmentComplete || onboardingMessageSent || messages.length > 0) return;

    const welcomeMessage = {
      role: 'assistant',
      content: "Welcome to Nexus! 🚀 Let's get you set up.\n\nFirst — do you have a Coinbase account? If not, I can help you create one. If you do, I'll guide you through connecting your API keys so I can check your balance and set up your risk profile.",
      id: 'onboarding-welcome-' + Date.now()
    };

    setMessages(prev => [welcomeMessage, ...prev]);
    setOnboardingMessageSent(true);
  }, [tenantId, riskAssessmentComplete, onboardingMessageSent, messages.length, setMessages]);

  // Trial grace period check
  useEffect(() => {
    if (!session?.user?.id) return;
    const checkGrace = async () => {
      const { data: userData } = await supabase
        .from('tenant_users')
        .select('tenants(created_at)')
        .eq('auth_user_id', session.user.id)
        .single();

      if (userData?.tenants?.created_at) {
        const created = new Date(userData.tenants.created_at);
        const now = new Date();
        const daysSinceCreation = (now - created) / (1000 * 60 * 60 * 24);
        // Trial is 14 days, grace period is 3 days after trial ends
        if (daysSinceCreation > 14 && daysSinceCreation <= 17) {
          const daysLeft = Math.ceil(17 - daysSinceCreation);
          setGraceBanner({ daysLeft });
        } else {
          setGraceBanner(null);
        }
      }
    };
    checkGrace();
  }, [session?.user?.id, supabase]);

  const fetchData = useCallback(async () => {
    // Guard: don't fetch data without tenant_id to prevent cross-tenant leakage
    if (!tenantId) {
      console.log("[FETCH DATA] No tenant_id yet, skipping fetch to prevent cross-tenant data leakage.");
      return;
    }

    try {
      // Build queries with tenant_id filtering
      let logsQuery = supabase.from('trade_logs').select('*').order('created_at', { ascending: false });
      let configsQuery = supabase.from('strategy_config').select('*');
      let scansQuery = supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(25);
      let sessionLogsQuery = supabase.from('agent_session_logs').select('*').order('timestamp', { ascending: false }).limit(200);

      // Add tenant_id filtering if available
      if (tenantId) {
        logsQuery = logsQuery.eq('tenant_id', tenantId);
        configsQuery = configsQuery.eq('tenant_id', tenantId);
        scansQuery = scansQuery.eq('tenant_id', tenantId);
        sessionLogsQuery = sessionLogsQuery.eq('tenant_id', tenantId);
      }

      const [logsRes, configsRes, scansRes, sessionLogsRes] = await Promise.all([
          logsQuery,
          configsQuery,
          scansQuery,
          sessionLogsQuery
      ]);

      // Deep compare to prevent unnecessary re-renders that cause flickering
      const newLogs = logsRes.data || [];
      const newConfigs = configsRes.data || [];
      setTradeLogs(prev => JSON.stringify(prev) === JSON.stringify(newLogs) ? prev : newLogs);
      console.log("[FETCH DATA] tradeLogs updated with", newLogs.length, "items.");
      setActiveStrategies(prev => JSON.stringify(prev) === JSON.stringify(newConfigs) ? prev : newConfigs);
      setScanStream(prev => JSON.stringify(prev) === JSON.stringify(scansRes.data || []) ? prev : (scansRes.data || []));
      setSessionLogs(prev => JSON.stringify(prev) === JSON.stringify(sessionLogsRes.data || []) ? prev : (sessionLogsRes.data || []));
      
      setLoading(false); 

      fetch(`/api/portfolio?asset=${activeAsset}`, {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setPortfolio(data);
                  if (data.price > 0) setLivePrice(data.price);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Portfolio API delayed:", e.message));

      fetch('/api/coinbase-sync', {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
          .then(res => res.json())
          .then(data => {
              if (data) {
                  setLivePositions(data.positions || []);
                  setLiveOrders(data.orders || []);
              }
          })
          .catch(e => console.warn("[NEXUS SYNC] Exchange API delayed:", e.message));

      fetch(`/api/get-strategies-for-asset?asset=${activeAsset}`, {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
      })
      .then(res => res.json())
      .then(data => {
          if (data && data.strategies) {
              setStrategyMetadata(data.strategies);
          }
      })
      .catch(e => console.warn("[NEXUS SYNC] Strategy Metadata API delayed:", e.message));

    } catch (e) { 
      console.error("[NEXUS FATAL] DB Fetch Error:", e); 
      setLoading(false); 
    }
  }, [activeAsset, supabase, tenantId, session?.access_token]);

  useEffect(() => {
    // Debug log for fetchData calls
    console.log("[FETCH DATA] fetchData triggered.");
    fetchData();
    const int = setInterval(() => {
        console.log("[FETCH DATA] fetchData interval triggered.");
        fetchData();
    }, 8000);
    return () => clearInterval(int);
  }, [fetchData]);

  useEffect(() => {
     const dbAssets = new Set([...assetsList, ...tradeLogs.map(l => l.symbol), ...activeStrategies.map(s => s.asset)]);
     const uniqueAssets = Array.from(dbAssets).filter(Boolean);
     if (uniqueAssets.length > assetsList.length) setAssetsList(uniqueAssets);
  }, [tradeLogs, activeStrategies, assetsList]);

  const handleAddAsset = (assetToAdd) => {
      const newAsset = assetToAdd.trim().toUpperCase();
      if(newAsset && !assetsList.includes(newAsset)) {
          setAssetsList(prev => [newAsset, ...prev]);
      }
      setActiveAsset(newAsset);
  };

  const handleToggleStrategy = async (configId, currentState) => {
      try {
          await supabase.from('strategy_config').update({ is_active: !currentState }).eq('id', configId);
          fetchData(); 
      } catch (err) {
          console.error("Failed to toggle strategy:", err);
      }
  };


  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); 
  }, [messages]);

  const handleClosePosition = async (trade) => {
    const confirmClose = window.confirm(`Liquidate ${trade.side} position on ${trade.strategy_id || 'Exchange'}?`);
    if (!confirmClose) return;
    const closingSide = (trade.side === 'BUY' || trade.side === 'LONG') ? 'SELL' : 'BUY';
    try {
      const closeRes = await fetch('/api/close-position', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          side: closingSide,
          qty: trade.qty,
          price: livePrice || 0
        })
      });
      if (closeRes.ok) {
        fetchData();
      } else {
        const err = await closeRes.json();
        alert(`Error closing position: ${err.error}`);
      }
    } catch (e) {
      alert(`Error closing position: ${e.message}`);
    }
  };

  const handleCancelOrder = async (order) => {
      const confirmCancel = window.confirm(`Cancel pending ${order.side} limit order for ${order.symbol}?`);
      if (!confirmCancel) return;
      
      try {
          await fetch('/api/cancel-order', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session?.access_token}`
              },
              body: JSON.stringify({ order_ids: [order.order_id] })
          });
          fetchData(); 
      } catch (e) {
          console.error("Cancel Order Failed:", e);
      }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!localInput?.trim() || isLoading) return;
    
    const content = localInput;
    setLocalInput(''); 
    
    try {
        await append({ role: 'user', content });
    } catch (err) {
        console.error("Append Fault:", err);
    }
  };

  const handleStrategySelect = async (stratId) => {
    await append({ role: 'user', content: `Brief me on the ${stratId} strategy currently running on ${activeAsset}.` });
  };

  const openStrategyEditor = (strat) => {
    setEditingStrategy(strat);
    setEditingParameters(normalizeParametersForEditor(strat.parameters));
    setEditingExecutionMode(strat.execution_mode || 'PAPER');
    setEditModalOpen(true);
  };

  const saveStrategyChanges = async () => {
    if (!editingStrategy) return;
    try {
      const { error } = await supabase
        .from('strategy_config')
        .update({
          parameters: flattenParametersForSave(editingParameters),
          execution_mode: editingExecutionMode,
          last_updated: new Date().toISOString()
        })
        .eq('id', editingStrategy.id);

      if (error) {
        console.error('Failed to update strategy:', error);
        alert(`❌ Failed to update strategy: ${error.message}`);
      } else {
        console.log('[DEBUG] Strategy updated successfully');
        alert('✅ Strategy updated successfully');
        setEditModalOpen(false);
        fetchData(); // Refresh data
      }
    } catch (err) {
      console.error('Failed to save strategy changes:', err);
      alert('❌ Failed to save strategy changes');
    }
  };

  // FIX: Filter strategies by normalized asset symbol for consistency
  const currentAssetStrategies = useMemo(() => {
    const normalizedActiveAsset = normalizeAssetSymbol(activeAsset);
    return activeStrategies.filter(s => normalizeAssetSymbol(s.asset) === normalizedActiveAsset);
  }, [activeStrategies, activeAsset, normalizeAssetSymbol]);

  // Swipe handlers for active matrix card strategy cycling
  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => {
      if (currentAssetStrategies.length > 1) {
        setCurrentStrategyIndex(prev => (prev + 1) % currentAssetStrategies.length);
      }
    },
    onSwipedRight: () => {
      if (currentAssetStrategies.length > 1) {
        setCurrentStrategyIndex(prev => (prev - 1 + currentAssetStrategies.length) % currentAssetStrategies.length);
      }
    },
    trackMouse: true,
    preventScrollOnSwipe: true
  });

  const paperPositions = useMemo(() => debouncedTradeLogs.filter(log => 
    !log.exit_price && 
    log.execution_mode === 'PAPER' &&
    normalizeAssetSymbol(log.symbol) === normalizeAssetSymbol(activeAsset)
  ), [debouncedTradeLogs, activeAsset, normalizeAssetSymbol]);
  
  const formattedLivePositions = useMemo(() => livePositions.map(pos => ({
      side: pos.side === 'LONG' ? 'BUY' : 'SELL',
      entry_price: parseFloat(pos.vwap || 0),
      qty: parseFloat(pos.number_of_contracts || 0),
      symbol: pos.product_id,
      execution_mode: 'LIVE (EXCHANGE)',
      strategy_id: 'ACTIVE_DERIVATIVE',
      pnl: parseFloat(pos.unrealized_pnl || 0),
      tp_price: pos.tp_price ? parseFloat(pos.tp_price) : null,
      sl_price: pos.sl_price ? parseFloat(pos.sl_price) : null,
      created_at: new Date().toISOString(),
      reason: ''
  })), [livePositions]);

  const openPositions = useMemo(() => [...formattedLivePositions, ...paperPositions], [formattedLivePositions, paperPositions]);
  
  const tradeHistory = useMemo(() => debouncedTradeLogs.filter(log => 
    log.exit_price &&
    normalizeAssetSymbol(log.symbol) === normalizeAssetSymbol(activeAsset)
  ), [debouncedTradeLogs, activeAsset, normalizeAssetSymbol]);
  
  const openOrders = useMemo(() => liveOrders.map(ord => ({
      order_id: ord.order_id, 
      side: ord.side,
      entry_price: parseFloat(ord.order_configuration?.limit_limit_gtc?.limit_price || 0),
      qty: parseFloat(ord.order_configuration?.limit_limit_gtc?.base_size || 0),
      symbol: ord.product_id,
      execution_mode: 'PENDING_LIMIT',
      strategy_id: 'AWAITING_FILL',
      created_at: ord.created_time || new Date().toISOString()
  })), [liveOrders]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    
    const isLight = theme === 'light';
    const chart = createChart(chartContainerRef.current, {
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: isLight ? '#475569' : '#94a3b8' },
        grid: { vertLines: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.03)' }, horzLines: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.03)' } },
        crosshair: { mode: CrosshairMode.Normal },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)' },
        rightPriceScale: { borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)' },
        autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#10b981', wickDownColor: '#ef4444'
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        visible: true, 
    });
    
    chart.priceScale('').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
    });

    const markersPlugin = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volumeSeries;
    seriesMarkersRef.current = markersPlugin; 

    // 🟢 THE UPGRADE: Infinite Scroll / Lazy Loading
    chart.timeScale().subscribeVisibleTimeRangeChange(async (newRange) => {
        if (!newRange || !seriesRef.current || isLoadingOlderRef.current) return;
        
        const currentData = allChartDataRef.current;
        if (currentData.length === 0) return;

        const tfMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
        const granularity = tfMap[chartTimeframe] || 60;
        const firstCandleTime = currentData[0].time;

        // Fetch when user is within 50 candles of the left edge
        if (newRange.from <= firstCandleTime + (granularity * 50)) {
            isLoadingOlderRef.current = true;
            const endTime = firstCandleTime;

            try {
                console.log(`[CHART] Stitching older data before ${new Date(endTime * 1000).toLocaleString()}...`);
                const res = await fetch(`/api/chart-data?asset=${activeAsset}&granularity=${granularity}&end=${endTime}&limit=1000`);
                if (res.ok) {
                    const olderData = await res.json();
                    if (Array.isArray(olderData) && olderData.length > 0) {
                        const merged = [...olderData, ...currentData].sort((a, b) => a.time - b.time);
                        
                        // Deduplicate merged set
                        const seen = new Set();
                        const uniqueMerged = merged.filter(d => {
                            if (seen.has(d.time)) return false;
                            seen.add(d.time);
                            return true;
                        });

                        allChartDataRef.current = uniqueMerged;
                        seriesRef.current.setData(uniqueMerged);
                        
                        const volumeData = uniqueMerged.map(c => ({
                            time: c.time, value: c.volume,
                            color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                        }));
                        volumeSeriesRef.current.setData(volumeData);
                    }
                }
            } catch (e) {
                console.error("Failed to load older data", e);
            } finally {
                setTimeout(() => { isLoadingOlderRef.current = false; }, 1000); // Cooldown
            }
        }
    });

    const handleResize = () => {
        if(chartContainerRef.current) {
            chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });
        }
    };
    
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
        resizeObserver.disconnect();
        chart.remove();
        seriesMarkersRef.current?.setMarkers([]); // Ensure markers are cleared on unmount/re-init
        priceLinesRef.current = []; // Clear price lines ref
        volumeLinesRef.current = []; // Clear volume lines ref
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update chart theme when toggling light/dark mode without recreating the chart
  useEffect(() => {
    if (!chartRef.current) return;
    const isLight = theme === 'light';
    chartRef.current.applyOptions({
      layout: { textColor: isLight ? '#475569' : '#94a3b8' },
      grid: { vertLines: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.03)' }, horzLines: { color: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.03)' } },
      timeScale: { borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)' },
      rightPriceScale: { borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)' },
    });
  }, [theme]); 

  useEffect(() => {
    let isMounted = true;
    let intervalId;

    // 🟢 Reset chart state when asset or timeframe changes
    allChartDataRef.current = [];
    isLoadingOlderRef.current = false;
    if (seriesRef.current) seriesRef.current.setData([]);
    if (volumeSeriesRef.current) volumeSeriesRef.current.setData([]);
    if (seriesMarkersRef.current) seriesMarkersRef.current.setMarkers([]);

    const loadChartData = async (isLiveTick = false) => {
        if(!seriesRef.current || !volumeSeriesRef.current || !chartRef.current) return;

        const tfMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
        const granularity = tfMap[chartTimeframe] || 60;

        try {
            // If live tick, we just want the latest. If full load, we want the first batch.
            const res = await fetch(`/api/chart-data?asset=${activeAsset}&granularity=${granularity}&limit=1000&deepCache=true`);
            if(!res.ok) throw new Error("Chart proxy failed");
            
            const data = await res.json();
            if(!isMounted) return;

            if (!Array.isArray(data) || data.length === 0) {
                if (!isLiveTick) {
                    console.log("[CHART DEBUG] No chart data or empty array. Clearing series.");
                    seriesRef.current.setData([]);
                    volumeSeriesRef.current.setData([]);
                    allChartDataRef.current = [];
                    seriesMarkersRef.current.setMarkers([]);
                }
                return;
            }

            if (isLiveTick) {
                const latestCandle = data[data.length - 1];
                seriesRef.current.update(latestCandle);
                
                // Update local ref as well
                const lastIdx = allChartDataRef.current.length - 1;
                if (lastIdx >= 0 && allChartDataRef.current[lastIdx].time === latestCandle.time) {
                    allChartDataRef.current[lastIdx] = latestCandle;
                } else {
                    allChartDataRef.current.push(latestCandle);
                }

                volumeSeriesRef.current.update({
                    time: latestCandle.time,
                    value: latestCandle.volume,
                    color: latestCandle.close >= latestCandle.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                });
            } else {
                seriesMarkersRef.current.setMarkers([]); 
                seriesRef.current.setData(data);
                allChartDataRef.current = data;

                // 🟢 THE FIX: Force absolute Y-axis reset to snap to new price range
                if (!isLiveTick) {
                    chartRef.current.timeScale().fitContent();
                    chartRef.current.priceScale('right').applyOptions({
                        autoScale: true,
                    });
                }
                
                const volumeData = data.map(c => ({
                    time: c.time,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                }));
                volumeSeriesRef.current.setData(volumeData);
            }
        } catch(e) { console.error("Chart Fetch Error:", e); }
    };

    loadChartData(false);
    intervalId = setInterval(() => loadChartData(true), 3000);

    return () => {
        isMounted = false;
        clearInterval(intervalId);
    };
  }, [activeAsset, chartTimeframe, normalizeAssetSymbol]);

  useEffect(() => {
      if (!seriesRef.current || !seriesMarkersRef.current || !debouncedTradeLogs || debouncedTradeLogs.length === 0 || !showMarkers) {
          seriesMarkersRef.current?.setMarkers([]); // Clear markers if conditions not met
          return;
      }
      seriesMarkersRef.current.setMarkers([]); // Proactive clear at start of effect

      try {
          const markers = [];
          const secondsMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
          const granularity = secondsMap[chartTimeframe] || 60;
          
          const currentData = seriesRef.current.data();
          if (!currentData || currentData.length === 0) return;
          
          const candleTimesArray = currentData.map(c => c.time);
          const usedTimes = new Set();
          
          // Filter logs to only include those matching the active asset
          const assetLogs = debouncedTradeLogs.filter(log => 
            normalizeAssetSymbol(log.symbol) === normalizeAssetSymbol(activeAsset)
          );
          
          [...assetLogs].reverse().forEach(log => {
              if (log.created_at) {
                  let rawTime = Math.floor(new Date(log.created_at).getTime() / 1000);
                  let snappedTime = candleTimesArray.reduce((prev, curr) => 
                      Math.abs(curr - rawTime) < Math.abs(prev - rawTime) ? curr : prev
                  );
                  
                  if (Math.abs(snappedTime - rawTime) <= granularity * 2) {
                      while(usedTimes.has(snappedTime)) snappedTime++; 
                      usedTimes.add(snappedTime);

                      const isBuy = log.side === 'BUY' || log.side === 'LONG';
                      const isShadow = log.execution_mode === 'SHADOW';
                      const entryPrice = log.entry_price ? `$${parseFloat(log.entry_price).toFixed(2)}` : '';

                      markers.push({
                          time: snappedTime,
                          position: isBuy ? 'belowBar' : 'aboveBar',
                          color: isShadow ? '#64748b' : (isBuy ? '#10b981' : '#ef4444'),
                          shape: isBuy ? 'arrowUp' : 'arrowDown',
                          text: isShadow ? '👻 VETO' : `${isBuy ? 'BUY' : 'SELL'} ${entryPrice}`
                      });
                  }
              }

              if (log.exit_time && log.execution_mode !== 'SHADOW') {
                  let rawExitTime = Math.floor(new Date(log.exit_time).getTime() / 1000);
                  let snappedExitTime = candleTimesArray.reduce((prev, curr) => 
                      Math.abs(curr - rawExitTime) < Math.abs(prev - rawExitTime) ? curr : prev
                  );

                  if (Math.abs(snappedExitTime - rawExitTime) <= granularity * 2) {
                      while(usedTimes.has(snappedExitTime)) snappedExitTime++; 
                      usedTimes.add(snappedExitTime);

                      const isBuy = log.side === 'BUY' || log.side === 'LONG';
                      const exitPosition = isBuy ? 'aboveBar' : 'belowBar';
                      const exitShape = isBuy ? 'arrowDown' : 'arrowUp';
                      const pnlText = log.pnl ? ` $${parseFloat(log.pnl).toFixed(2)}` : '';
                      
                      let text = 'CLOSE';
                      let color = '#94a3b8'; 
                      const reason = log.reason || '';

                      if (reason.includes('REVERSAL')) {
                          text = '⚡ REVERSAL'; color = '#a855f7';
                      } else if (reason.includes('TRIPWIRE')) {
                          text = '🛡️ TRIPWIRE'; color = '#f59e0b';
                      } else if (reason.includes('TAKE_PROFIT') || (log.pnl > 0 && !reason.includes('STOP_LOSS'))) {
                          text = '🎯 TP'; color = '#10b981';
                      } else if (reason.includes('STOP_LOSS') || log.pnl < 0) {
                          text = '🛑 SL'; color = '#ef4444';
                      }

                      markers.push({
                          time: snappedExitTime,
                          position: exitPosition,
                          color: color,
                          shape: exitShape,
                          text: text + pnlText
                      });
                  }
              }
          });

          markers.sort((a,b) => a.time - b.time);
          seriesMarkersRef.current.setMarkers(markers);

      } catch (e) { console.error("Chart Markers Error:", e); }

  }, [activeAsset, chartTimeframe, debouncedTradeLogs, normalizeAssetSymbol, openPositions, showMarkers]);

  // TP/SL price lines effect (controlled by showPriceLines toggle)
  useEffect(() => {
    if (!seriesRef.current) return;

    // Clear existing TP/SL/trap price lines
    priceLinesRef.current.forEach(pl => seriesRef.current.removePriceLine(pl));
    priceLinesRef.current = [];

    if (!showPriceLines) return; // Don't draw TP/SL lines when toggled off

    try {
      // Draw TP/SL lines for open positions
      openPositions.forEach(pos => {
        if (pos.tp_price) {
          const tp = seriesRef.current.createPriceLine({ price: pos.tp_price, color: '#10b981', lineWidth: 2, lineStyle: 2, title: 'TP' });
          priceLinesRef.current.push(tp);
        }
        if (pos.sl_price) {
          const sl = seriesRef.current.createPriceLine({ price: pos.sl_price, color: '#ef4444', lineWidth: 2, lineStyle: 2, title: 'SL' });
          priceLinesRef.current.push(sl);
        }
      });

      // Draw trap price line for active strategy
      const currentStrat = activeStrategies.find(s => normalizeAssetSymbol(s.asset) === normalizeAssetSymbol(activeAsset));
      if (currentStrat?.trap_price) {
        const tPrice = parseFloat(currentStrat.trap_price);
        const color = currentStrat.trap_side === 'BUY' ? '#10b981' : '#ef4444';
        const trapLine = seriesRef.current.createPriceLine({ price: tPrice, color: color, lineWidth: 2, lineStyle: 2, title: `👻 ${currentStrat.trap_side} TRAP` });
        priceLinesRef.current.push(trapLine);
      }
    } catch (err) {
      console.error("TP/SL Lines Drawing Error:", err);
    }
  }, [openPositions, activeStrategies, activeAsset, normalizeAssetSymbol, showPriceLines]);

  // Volume node lines effect (always on, independent of showPriceLines)
  useEffect(() => {
    if (!seriesRef.current) return;

    // Clear existing volume node lines
    volumeLinesRef.current.forEach(pl => seriesRef.current.removePriceLine(pl));
    volumeLinesRef.current = [];

    try {
      const assetScans = scanStream.filter(s => normalizeAssetSymbol(s.asset) === normalizeAssetSymbol(activeAsset));
      const latestAssetScan = assetScans.length > 0 ? assetScans[0] : null;
      if (latestAssetScan?.telemetry) {
        const t = latestAssetScan.telemetry;

        if (t.macro_poc && t.macro_poc !== "None") {
          const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.macro_poc), color: '#f59e0b', lineWidth: 2, lineStyle: 0, title: 'MACRO POC' });
          volumeLinesRef.current.push(pl);
        }
        if (t.upper_macro_node && t.upper_macro_node !== "None") {
          const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.upper_macro_node), color: '#94a3b8', lineWidth: 1, lineStyle: 1, title: 'UPPER NODE' });
          volumeLinesRef.current.push(pl);
        }
        if (t.lower_macro_node && t.lower_macro_node !== "None") {
          const pl = seriesRef.current.createPriceLine({ price: parseFloat(t.lower_macro_node), color: '#94a3b8', lineWidth: 1, lineStyle: 1, title: 'LOWER NODE' });
          volumeLinesRef.current.push(pl);
        }
      }
    } catch (err) {
      console.error("Volume Node Lines Error:", err);
    }
  }, [activeAsset, scanStream, normalizeAssetSymbol]);

  // Update header metrics when activeAsset or scanStream changes
  useEffect(() => {
    const activeAssetScans = scanStream.filter(s => normalizeAssetSymbol(s.asset) === normalizeAssetSymbol(activeAsset));
    const scan = activeAssetScans.length > 0 ? activeAssetScans[0] : null;
    
    setLatestScan(scan);
    const b = parseFloat(scan?.telemetry?.bids || 0);
    const a = parseFloat(scan?.telemetry?.asks || 0);
    const c = parseFloat(scan?.telemetry?.cvd || 0);
    
    setBids(b);
    setAsks(a);
    setCvd(c);
    
    const totalLiq = b + a;
    setTotalLiquidity(totalLiq);
    const targetPct = totalLiq > 0 ? (b / totalLiq) * 100 : 50;
    setTargetPercent(targetPct);
    
    console.log(`[DEBUG] Header metrics updated for ${activeAsset}: bids=${b}, asks=${a}, cvd=${c}`);
  }, [activeAsset, scanStream, normalizeAssetSymbol]);

  // Auto-load first active strategy when asset changes
  useEffect(() => {
    setCurrentStrategyIndex(0);
  }, [currentAssetStrategies, activeAsset]);

  const [liveBidPercent, setLiveBidPercent] = useState(50);

  useEffect(() => {
      setLiveBidPercent(targetPercent); 
      
      if (totalLiquidity === 0) return; 

      const jitterInterval = setInterval(() => {
          const microJitter = (Math.random() - 0.5) * 2; 
          setLiveBidPercent(prev => Math.max(1, Math.min(99, targetPercent + microJitter)));
      }, 1200);

      return () => clearInterval(jitterInterval);
  }, [targetPercent, totalLiquidity]);

  const isVeto = latestScan?.status === 'ORACLE VETO';
  const isResonant = latestScan?.status === 'RESONANT';
  const isExchangeActive = openPositions.length > 0 || openOrders.length > 0;


  // Apply filters to logs
  let displayLogs = [];
  let baseDisplayLogs = [];
  if (activeTab === 'POSITIONS') baseDisplayLogs = openPositions;
  else if (activeTab === 'TRADE_HISTORY') baseDisplayLogs = tradeHistory;
  else if (activeTab === 'OPEN_ORDERS') baseDisplayLogs = openOrders;

  // Filter by strategy
  let filteredByStrategy = baseDisplayLogs;
  if (logStrategyFilter !== 'ALL') {
    filteredByStrategy = baseDisplayLogs.filter(log => log.strategy_id === logStrategyFilter || log.strategy_id?.replace('_V1', '') === logStrategyFilter);
  }

  // Filter by status (for trade history: WINNER/LOSER/SHADOW, for positions: ACTIVE, for orders: PENDING)
  let filteredByStatus = filteredByStrategy;
  if (logStatusFilter !== 'ALL') {
    if (activeTab === 'TRADE_HISTORY') {
      if (logStatusFilter === 'WINNER') filteredByStatus = filteredByStrategy.filter(log => log.pnl > 0);
      else if (logStatusFilter === 'LOSER') filteredByStatus = filteredByStrategy.filter(log => log.pnl < 0);
      else if (logStatusFilter === 'SHADOW') filteredByStatus = filteredByStrategy.filter(log => log.execution_mode === 'SHADOW');
    } else if (activeTab === 'POSITIONS') {
      if (logStatusFilter === 'ACTIVE') filteredByStatus = filteredByStrategy.filter(log => !log.exit_price);
    } else if (activeTab === 'OPEN_ORDERS') {
      if (logStatusFilter === 'PENDING') filteredByStatus = filteredByStrategy.filter(log => log.execution_mode === 'PENDING_LIMIT');
    }
  }

  displayLogs = filteredByStatus;

  // Fetch risk profile preview when profile modal opens
  useEffect(() => {
    if (!showProfileModal || !tenantId) return;
    const fetchRiskPreview = async () => {
      try {
        const { data } = await supabase
          .from('tenant_settings')
          .select('account_balance_usd, risk_per_trade_percent, max_position_size_usd, max_leverage, daily_roi_target_usd, max_concurrent_trades')
          .eq('tenant_id', tenantId)
          .single();
        setRiskPreview(data || null);
      } catch (e) {
        setRiskPreview(null);
      }
    };
    fetchRiskPreview();
  }, [showProfileModal, tenantId, supabase]);


  return (
    <div className="min-h-screen dark:bg-[#020617] dark:text-slate-200 bg-white text-slate-900 px-2 sm:px-4 py-4 font-sans flex flex-col gap-4 relative">
      
      {isDefconActive && (
          <div className="bg-red-500/20 border-b border-red-500/50 text-red-200 px-6 py-3 flex items-center justify-center gap-3 w-full animate-pulse z-50">
              <AlertTriangle size={18} className="text-red-400" />
              <span className="text-[11px] font-black uppercase tracking-widest">
                  DEFCON 3: OVERNIGHT MARGIN SWEEP APPROACHING. VERIFY CAPITAL OR FLATTEN OPEN DERIVATIVE POSITIONS.
              </span>
          </div>
      )}

      {loading && (
         <div className="absolute inset-0 z-50 dark:bg-[#020617]/90 bg-white/90 backdrop-blur-sm flex items-center justify-center font-mono text-indigo-500 animate-pulse uppercase tracking-[0.4em]">
             Establishing Nexus...
         </div>
      )}

      {/* Trial Grace Period Banner */}
      {graceBanner && (
        <div className="max-w-[1800px] w-full mx-auto mt-2 px-4 sm:px-0">
          <div className="bg-amber-600/30 border border-amber-500/30 rounded-2xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
              <div>
                <p className="text-sm font-bold text-amber-300">Your free trial has ended.</p>
                <p className="text-xs text-amber-400/80">You have {graceBanner.daysLeft} day{graceBanner.daysLeft !== 1 ? 's' : ''} to subscribe before your account is paused.</p>
              </div>
            </div>
            <Link href="/plans" className="text-[10px] font-black uppercase tracking-widest bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 px-4 py-2 rounded-lg transition-all flex-shrink-0">
              Subscribe Now
            </Link>
          </div>
        </div>
      )}

      <header id="dashboard-header" className="max-w-[1800px] w-full mx-auto flex justify-between items-center border-b dark:border-white/5 border-slate-300/5 pb-4 px-4 sm:px-0">
        <div className="flex items-center gap-2 sm:gap-4">
            <h1 className="text-lg sm:text-xl font-black italic tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent uppercase">Nexus</h1>
            <div className="hidden sm:block h-6 w-[1px] bg-white/10 mx-2" />
            <div className="hidden sm:flex items-center gap-2">
                <Link href="/audit" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Shield className="w-3 h-3" /> Audit
                </Link>
                <button id="settings-btn" onClick={() => setShowProfileModal(true)} className="text-[10px] font-black uppercase tracking-widest bg-slate-500/10 hover:bg-slate-500/20 text-slate-300 border border-white/5 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Settings className="w-3 h-3" /> Profile
                </button>
                <button 
                    onClick={toggleTheme} 
                    className="text-[10px] font-black uppercase tracking-widest bg-slate-500/10 hover:bg-slate-500/20 text-slate-300 border border-white/5 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2"
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                    {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                    {theme === 'dark' ? 'Light' : 'Dark'}
                </button>
                <Link href="/performance" target="_blank" className="text-[10px] font-black uppercase tracking-widest bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2">
                  <Activity className="w-3 h-3" /> Performance
                </Link>
            </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-8">
            <div className="hidden md:flex items-center gap-6">
                <div className="flex flex-col items-end">
                    <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-1"><Shield size={8} className="text-emerald-400"/> Live Equity</span>
                    <span className="text-sm font-black font-mono text-white">${portfolio.live?.balance?.toFixed(2) || '0.00'}</span>
                </div>
                <div className="flex flex-col items-end">
                    <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-1"><Cpu size={8} className="text-indigo-400"/> Nexus Paper</span>
                    <span className="text-sm font-black font-mono text-slate-300">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</span>
                </div>
            </div>
            <div className="hidden sm:flex text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em] items-center gap-2 bg-white/5 px-3 py-2 rounded-lg border border-white/5"><Database size={10} /> Sync</div>
            <button onClick={() => setShowMobileMenu(!showMobileMenu)} className="sm:hidden p-2 rounded-lg hover:bg-white/5 transition-colors">
                {showMobileMenu ? <X size={18} /> : <Menu size={18} />}
            </button>
        </div>
      </header>

      {showMobileMenu && (
        <div className="sm:hidden bg-slate-900/50 border-b border-white/5 p-4 space-y-3 z-40 flex flex-col">
          <Link href="/audit" target="_blank" onClick={() => setShowMobileMenu(false)} className="text-[9px] font-black uppercase tracking-widest bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Shield className="w-3 h-3" /> Audit
          </Link>
          <button onClick={() => { setShowProfileModal(true); setShowMobileMenu(false); }} className="text-[9px] font-black uppercase tracking-widest bg-slate-500/10 text-slate-300 border border-white/5 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Settings className="w-3 h-3" /> Profile
          </button>
          <button 
              onClick={() => { toggleTheme(); setShowMobileMenu(false); }} 
              className="text-[9px] font-black uppercase tracking-widest bg-slate-500/10 text-slate-300 border border-white/5 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full"
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <Link href="/performance" target="_blank" onClick={() => setShowMobileMenu(false)} className="text-[9px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-3 py-2 rounded-lg transition-colors flex items-center gap-2 w-full">
            <Activity className="w-3 h-3" /> Performance
          </Link>
          <div className="border-t border-white/5 pt-3 mt-3">
            <div className="flex flex-col gap-2">
              <div className="flex justify-between">
                <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Live:</span>
                <span className="text-[9px] font-black font-mono text-emerald-400">${portfolio.live?.balance?.toFixed(2) || '0.00'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Paper:</span>
                <span className="text-[9px] font-black font-mono text-indigo-400">${portfolio.paper?.balance?.toFixed(2) || '5000.00'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🔴 NEW COINBASE STYLE TICKER BAR */}
      <div className="max-w-[1800px] w-full mx-auto bg-slate-900/40 border border-white/5 rounded-2xl p-2 px-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 sm:gap-0 backdrop-blur-md relative z-40">
        <div className="w-full sm:w-auto flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8">
          <div className="relative w-full sm:w-auto">
            <button 
              onClick={() => setShowScanner(!showScanner)}
              className="w-full sm:w-auto flex items-center gap-2 sm:gap-3 group px-3 sm:px-4 py-2 rounded-xl hover:bg-white/5 transition-all"
            >
              <div className="flex flex-col items-start w-full">
                <span className="text-[7px] sm:text-[8px] font-black text-indigo-500 uppercase tracking-widest">Market</span>
                <div className="flex items-center gap-2 w-full">
                  <span className="text-base sm:text-lg font-black text-white italic tracking-tighter uppercase truncate">{activeAsset}</span>
                  <ChevronDown size={14} className={`text-slate-500 transition-transform flex-shrink-0 ${showScanner ? 'rotate-180' : ''}`} />
                </div>
              </div>
            </button>

            {showScanner && (
              <div id="market-scanner" className="absolute top-full left-0 mt-2 w-full sm:w-[calc(100vw-32px)] md:w-96 bg-[#020617] border border-white/10 rounded-3xl shadow-2xl z-50 p-2 overflow-hidden animate-in fade-in slide-in-from-top-2 max-h-[calc(100vh-150px)]">
                <div className="flex items-center justify-between p-3 border-b border-white/5">
                   <span className="text-[9px] sm:text-[10px] font-black uppercase text-indigo-400 tracking-widest">Select Asset</span>
                   <button onClick={() => setShowScanner(false)} className="text-slate-500 hover:text-white"><X size={14}/></button>
                </div>
                <div className="p-2">
                  <MarketScanner 
                    onSelectAsset={(assetId) => {
                      setActiveAsset(assetId);
                      handleAddAsset(assetId);
                      setShowScanner(false);
                    }}
                    currentAsset={activeAsset}
                    activeStrategies={activeStrategies}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="flex-1 sm:flex-none flex flex-col">
            <span className="text-[7px] sm:text-[8px] font-black text-emerald-500/60 uppercase tracking-widest">Market Feed</span>
            <div className="flex items-baseline gap-1 sm:gap-2">
              <span className={`text-lg sm:text-xl font-mono font-black tracking-tighter ${livePrice > 0 ? 'text-emerald-400' : 'text-slate-700'}`}>
                ${livePrice > 0 ? livePrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '---'}
              </span>
              <span className="text-[8px] sm:text-[9px] font-bold text-slate-500 uppercase">USD</span>
            </div>
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">CVD</span>
                <span className={`text-xs sm:text-sm font-mono font-bold ${cvd !== 0 ? (cvd > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}>
                    {cvd > 0 ? '+' : ''}{cvd.toFixed(0)}
                </span>
             </div>
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Score</span>
                <span className="text-xs sm:text-sm font-mono font-bold text-indigo-400">{latestScan?.telemetry?.oracle_score || '--'}</span>
             </div>
             <div className="flex flex-col">
                <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Regime</span>
                {latestScan?.telemetry?.macro_regime_oracle && (
                    <span className={`text-[8px] sm:text-[10px] font-black uppercase tracking-widest ${latestScan.telemetry.macro_regime_oracle === 'TREND' ? 'text-emerald-400' : (latestScan.telemetry.macro_regime_oracle === 'CHOP' ? 'text-amber-400' : 'text-slate-500')}`}>
                        {latestScan.telemetry.macro_regime_oracle}
                    </span>
                )}
             </div>
          </div>

          <div className="hidden sm:block h-8 w-[1px] bg-white/5" />

          <div className="w-full sm:w-48 flex flex-col">
              <div className="flex justify-between items-center mb-1">
                  <span className="text-[7px] sm:text-[8px] font-black text-slate-500 uppercase tracking-widest">Liquidity</span>
                  <div className="flex gap-1 sm:gap-2 text-[7px] sm:text-[8px] font-mono">
                      <span className="text-emerald-400">B:{bids.toFixed(0)}</span>
                      <span className="text-red-400">A:{asks.toFixed(0)}</span>
                  </div>
              </div>
              {totalLiquidity > 0 ? (
                  <div className="w-full h-1.5 rounded-full overflow-hidden flex bg-slate-800">
                      <div style={{ width: `${liveBidPercent}%` }} className="h-full bg-emerald-500/80 transition-all duration-500 ease-linear" />
                      <div style={{ width: `${100 - liveBidPercent}%` }} className="h-full bg-red-500/80 transition-all duration-500 ease-linear" />
                  </div>
              ) : <div className="h-1.5 bg-slate-800 rounded-full animate-pulse w-full" />}
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
             <div className={`px-3 py-1.5 rounded-lg border flex items-center gap-2 transition-all ${isResonant ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 animate-pulse shadow-[0_0_15px_-3px_rgba(16,185,129,0.4)]' : (isVeto ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-slate-800/50 text-slate-600 border-white/5')}`}>
                <div className={`h-1.5 w-1.5 rounded-full ${isResonant ? 'bg-emerald-400' : (isVeto ? 'bg-red-400' : 'bg-slate-600')}`} />
                <span className="text-[9px] font-black uppercase tracking-widest">{latestScan?.status || 'IDLE'}</span>
             </div>
        </div>
      </div>

      <main className="max-w-[1800px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 md:gap-6 grow overflow-hidden px-4 sm:px-0">
        
        <div className="lg:col-span-9 flex flex-col gap-3 sm:gap-4 md:gap-6 min-h-0 h-[calc(100vh-280px)] sm:h-[calc(100vh-240px)] md:h-[calc(100vh-200px)] lg:h-[calc(100vh-180px)]">
          
          <div id="chart-panel" className={isChartMaximized ? "fixed inset-4 z-[100] bg-[#020617] border border-indigo-500/50 rounded-3xl p-6 shadow-2xl flex flex-col transition-all" : "dark:bg-slate-900/50 bg-white/90 border dark:border-white/10 border-slate-200 rounded-2xl sm:rounded-[2.5rem] overflow-hidden min-h-[300px] flex-grow relative shadow-2xl flex flex-col transition-all"}>
            
            <button onClick={() => setIsChartMaximized(!isChartMaximized)} className="absolute top-2 right-2 sm:top-4 sm:right-4 z-50 dark:bg-black/40 bg-white/80 hover:bg-indigo-500/20 dark:text-slate-400 text-slate-600 hover:text-indigo-300 dark:border-white/10 border-slate-200 hover:border-indigo-500/50 p-1 sm:p-2 rounded-lg transition-colors backdrop-blur-md">
                {isChartMaximized ? <Minimize2 size={12} className="sm:size-[14px]"/> : <Maximize2 size={12} className="sm:size-[14px]"/>}
            </button>

            <div className="hidden sm:block absolute top-6 right-16 z-20 flex flex-col gap-2 max-w-[280px] pointer-events-none">
               {openPositions.slice(0, 3).map((log, i) => {
                 const displayPnl = log.execution_mode.includes('LIVE') ? log.pnl : 
                 ((log.side === 'BUY' || log.side === 'LONG') ? (livePrice - log.entry_price) * (log.qty || 1) : (log.entry_price - livePrice) * (log.qty || 1));
                 return (
                  <div key={i} className="bg-black/70 backdrop-blur-md border border-white/10 p-2 px-3 rounded-xl text-[9px] font-mono flex items-center justify-between gap-4 pointer-events-auto shadow-lg">
                     <div className="flex flex-col gap-0.5">
                       <div className="flex items-center gap-2">
                         <span className={log.side === 'BUY' || log.side === 'LONG' ? 'text-emerald-400 animate-pulse' : 'text-amber-400 animate-pulse'}>●</span>
                         <span className="text-slate-300 uppercase font-bold">{log.side} {log.qty ? `(${log.qty.toLocaleString()})` : ''} @ {log.entry_price}</span>
                       </div>
                       <div className="flex items-center gap-3">
                         <span className="text-[7px] text-slate-500 font-black tracking-widest uppercase pl-3">{log.strategy_id}</span>
                       </div>
                     </div>
                     {livePrice > 0 && (
                         <span className={`font-black ${displayPnl >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>
                             {displayPnl >= 0 ? '+' : ''}{displayPnl?.toFixed(4)}
                         </span>
                     )}
                  </div>
                 )
               })}
            </div>

            <div className="px-6 py-3 flex items-center justify-between border-b dark:border-white/5 border-slate-200 dark:bg-black/20 bg-slate-100 backdrop-blur-md rounded-t-[2rem]">
              <div className="flex items-center gap-4">
                <div className="flex dark:bg-black/40 bg-slate-200 p-1 rounded-xl border dark:border-white/5 border-slate-300 gap-1">
                  {['1m', '5m', '15m', '1h', '4h'].map(tf => (
                    <button 
                      key={tf} 
                      onClick={() => setChartTimeframe(tf)}
                      className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase transition-all ${chartTimeframe === tf ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'dark:text-slate-500 text-slate-600 hover:text-slate-300'}`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowMarkers(prev => !prev)}
                  className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase transition-all ${showMarkers ? 'bg-emerald-600/30 text-emerald-400 border border-emerald-500/30' : 'dark:bg-slate-800/50 bg-slate-200 dark:text-slate-500 text-slate-600 border dark:border-white/5 border-slate-300'}`}
                  title="Toggle trade markers on chart"
                >
                  {showMarkers ? '🔖 ON' : '🔖 OFF'}
                </button>
                <button
                  onClick={() => setShowPriceLines(prev => !prev)}
                  className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase transition-all ${showPriceLines ? 'bg-amber-600/30 text-amber-400 border border-amber-500/30' : 'dark:bg-slate-800/50 bg-slate-200 dark:text-slate-500 text-slate-600 border dark:border-white/5 border-slate-300'}`}
                  title="Toggle TP/SL price lines on chart"
                >
                  {showPriceLines ? '📊 TP/SL' : '📊 OFF'}
                </button>
              </div>
            </div>

            <div className="flex-grow w-full relative mt-0 mb-4 px-2 min-h-[300px]">
                <div ref={chartContainerRef} className="absolute inset-0" />
            </div>
          </div>

          <div id="trade-ledger" className="flex flex-col flex-grow min-h-0 overflow-hidden max-h-[85%] sm:max-h-[80%] md:max-h-[50%] border dark:border-white/5 border-slate-200 rounded-2xl sm:rounded-[2rem] dark:bg-slate-900/30 bg-slate-100 pb-2">
            <div className="flex items-center gap-6 px-6 pt-5 border-b dark:border-white/5 border-slate-200 dark:bg-slate-950/80 bg-white sticky top-0 z-20">
               <button 
                  onClick={() => setActiveTab('OPEN_ORDERS')} 
                  className={`pb-3 text-[9px] sm:text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'OPEN_ORDERS' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Open Orders {openOrders.length > 0 && <span className="ml-1 bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded-full text-[8px]">{openOrders.length}</span>}
               </button>
               <button 
                  onClick={() => setActiveTab('POSITIONS')} 
                  className={`pb-3 text-[9px] sm:text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'POSITIONS' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Positions {openPositions.length > 0 && <span className="ml-1 bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded-full text-[8px]">{openPositions.length}</span>}
               </button>
               <button 
                  onClick={() => setActiveTab('TRADE_HISTORY')} 
                  className={`pb-3 text-[9px] sm:text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'TRADE_HISTORY' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
               >
                  Trade History
               </button>
            </div>

            {/* Log Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b border-white/5 bg-slate-950/40 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Strategy:</label>
                <select 
                  value={logStrategyFilter}
                  onChange={(e) => setLogStrategyFilter(e.target.value)}
                  className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1 text-[9px] font-bold text-slate-300 outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="ALL">All</option>
                  {[...new Set(baseDisplayLogs.map(log => log.strategy_id).filter(Boolean))].map(strat => (
                    <option key={strat} value={strat}>{strat?.replace('_V1', '')}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Status:</label>
                <select 
                  value={logStatusFilter}
                  onChange={(e) => setLogStatusFilter(e.target.value)}
                  className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1 text-[9px] font-bold text-slate-300 outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="ALL">All</option>
                  {activeTab === 'TRADE_HISTORY' && (
                    <>
                      <option value="WINNER">Winner (P&L +)</option>
                      <option value="LOSER">Loser (P&L -)</option>
                      <option value="SHADOW">Shadow (Veto)</option>
                    </>
                  )}
                  {activeTab === 'POSITIONS' && (
                    <option value="ACTIVE">Active</option>
                  )}
                  {activeTab === 'OPEN_ORDERS' && (
                    <option value="PENDING">Pending</option>
                  )}
                </select>
              </div>
            </div>

            <div className="overflow-y-auto overflow-x-auto custom-scrollbar flex-grow min-h-[200px] max-h-[calc(100vh-300px)] resize-y">
              {displayLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12 min-h-[200px]">
                  <Layers size={24} className="mb-2 opacity-50" />
                  <p className="text-[11px] font-bold uppercase tracking-widest">No data available</p>
                </div>
              ) : (
                <table className="w-full min-w-max text-left">
                  <thead className="dark:bg-slate-950/40 bg-slate-100 text-[8px] sm:text-[9px] font-black dark:text-slate-600 text-slate-700 uppercase tracking-widest sticky top-0 backdrop-blur-md z-10">
                    <tr>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px]">Date</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[80px] sm:min-w-[100px] text-center">Context</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[50px] sm:min-w-[60px] text-center">Vector</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[80px] text-center">Entry</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[70px] sm:min-w-[80px] text-center">Targets</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px]">Status</th>
                      <th className="px-1.5 sm:px-2 py-1.5 sm:py-2 whitespace-nowrap min-w-[60px] sm:min-w-[70px] text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-mono text-[8px] sm:text-xs text-slate-400">
                    {displayLogs.map((log, i) => {
                      const isShadow = log.execution_mode === 'SHADOW';
                      const isReversal = log.reason && log.reason.includes('[REVERSAL');
                      const isTripwire = log.reason && log.reason.includes('[TRIPWIRE');
                      
                      let pnlDisplay = '--';
                      if (isShadow) {
                          pnlDisplay = <span className="text-slate-600">VETO</span>;
                      } else if (log.exit_price) {
                          pnlDisplay = <span className={log.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)}</span>;
                      } else if (log.execution_mode === 'LIVE (EXCHANGE)') {
                          pnlDisplay = <span className={log.pnl >= 0 ? 'text-cyan-400 animate-pulse' : 'text-amber-400 animate-pulse'}>{log.pnl >= 0 ? '+' : ''}${log.pnl?.toFixed(4)} (U)</span>;
                      } else if (livePrice > 0 && activeTab === 'POSITIONS') {
                          const paperPnl = (log.side === 'BUY' ? livePrice - log.entry_price : log.entry_price - livePrice) * (log.qty || 1);
                          pnlDisplay = <span className={`animate-pulse ${paperPnl >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>${paperPnl.toFixed(4)} (U)</span>;
                      }
                      
                      const timestamp = log.created_at || log.exit_time;
                      const formattedTime = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";

                      return (
                      <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${isShadow ? 'opacity-50' : ''}`}>
                        <td className="responsive-table-cell date text-[8px] sm:text-[9px] text-slate-500 px-1.5 sm:px-2 py-1 sm:py-1.5">
                            <div className="flex flex-col"><span className="text-[8px] sm:text-[10px] font-bold text-slate-400">{formattedTime}</span></div>
                        </td>
                        <td className="responsive-table-cell context text-center px-1.5 sm:px-2 py-1 sm:py-1.5">
                            <div className="flex flex-col items-center gap-0.5">
                                <span className="text-[7px] sm:text-[8px] font-black uppercase px-1.5 sm:px-2 py-0.5 rounded border bg-indigo-500/5 text-indigo-300/80 border-indigo-500/10">
                                  {log.strategy_id ?? ''}
                                </span>
                                {isShadow && <span className="text-[6px] sm:text-[7px] bg-red-500/20 text-red-300 px-1 rounded uppercase tracking-widest">VETO</span>}
                                {isReversal && !isShadow && <span className="text-[6px] sm:text-[7px] bg-purple-500/20 text-purple-300 px-1 rounded uppercase tracking-widest">REV</span>}
                                {isTripwire && !isShadow && <span className="text-[6px] sm:text-[7px] bg-amber-500/20 text-amber-300 px-1 rounded uppercase tracking-widest">TRIP</span>}
                            </div>
                        </td>
                        <td className="responsive-table-cell vector text-center px-1.5 sm:px-2 py-1 sm:py-1.5">
                            <span className={`px-1.5 sm:px-2 py-0.5 rounded-full text-[7px] sm:text-[9px] font-black whitespace-nowrap ${isShadow ? 'bg-slate-800 text-slate-500' : (log.side === 'BUY' || log.side === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}`}>
                                {log.side} {log.qty > 0 ? `(${log.qty})` : ''}
                            </span>
                        </td>
                        <td className="responsive-table-cell entry text-[8px] sm:text-[10px] text-slate-300 text-center px-1.5 sm:px-2 py-1 sm:py-1.5">
                            {log.entry_price ? `$${log.entry_price.toFixed(2)}` : '---'}
                        </td>
                        <td className="responsive-table-cell targets text-center px-1.5 sm:px-2 py-1 sm:py-1.5">
                            {isShadow ? <span className="text-slate-700 italic text-[7px] sm:text-[9px]">Rejected</span> : 
                             (log.tp_price || log.sl_price ? (
                                <div className="flex flex-col text-[7px] sm:text-[8px] tracking-tighter uppercase">
                                    <span className="text-emerald-500/60">TP: ${log.tp_price ? log.tp_price.toFixed(2) : '---'}</span>
                                    <span className="text-red-500/60">SL: ${log.sl_price ? log.sl_price.toFixed(2) : '---'}</span>
                                </div>
                            ) : <span className="text-slate-700 italic text-[7px] sm:text-[9px]">Dynamic</span>)}
                        </td>
                        <td className="responsive-table-cell status text-center px-1.5 sm:px-2 py-1 sm:py-1.5">
                            {isShadow ? <span className="text-[8px] sm:text-[9px] text-red-400 font-bold">VETOED</span> :
                            (log.exit_price ? <span className="text-[8px] sm:text-[10px] text-slate-400">${log.exit_price.toFixed(2)}</span> : 
                             <><span className="text-indigo-400 animate-pulse font-black text-[8px] sm:text-[9px]">{log.execution_mode.includes('PENDING') ? 'PENDING' : 'ACTIVE'}</span> 
                             <button onClick={() => log.execution_mode.includes('PENDING') ? handleCancelOrder(log) : handleClosePosition(log)} className="ml-1 sm:ml-2 bg-red-500/10 text-red-400 border border-red-500/30 px-1 sm:px-2 py-0.5 rounded text-[7px] sm:text-[8px] font-black">X</button></>)}
                        </td>
                        <td className="responsive-table-cell pnl text-right font-black text-[8px] sm:text-[10px] px-1.5 sm:px-2 py-1 sm:py-1.5">{pnlDisplay}</td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

                <div className="lg:col-span-3 flex flex-col gap-3 sm:gap-4 md:gap-6 h-auto lg:h-[calc(100vh-180px)] overflow-hidden lg:resize-y pb-2">
          <div id="strategy-matrix" className="dark:bg-slate-900/50 bg-white/90 border dark:border-white/10 border-slate-200 rounded-2xl sm:rounded-[2.5rem] p-4 sm:p-6 shadow-2xl flex-shrink-0">
            <h3 className="text-[10px] font-black uppercase dark:text-slate-500 text-slate-600 mb-4 flex items-center justify-between">
              <span>Active Matrix</span>
              <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-mono uppercase">
                {normalizeAssetSymbol(activeAsset)}
              </span>
            </h3>
            
            {currentAssetStrategies.length === 0 ? (
                <div className="text-center py-8 text-slate-600 text-[10px] uppercase font-bold border border-dashed border-white/5 rounded-2xl">No Strategies Active</div>
            ) : (() => {
                const strat = currentAssetStrategies[currentStrategyIndex % currentAssetStrategies.length];
                if (!strat) return null;
                
                const stratLogs = tradeLogs.filter(l => (l.strategy_id === strat.strategy || l.strategy_id === strat.id) && l.execution_mode !== 'SHADOW' && l.exit_price);
                const totalPnL = stratLogs.reduce((sum, l) => sum + (l.pnl || 0), 0);
                
                // ROI Calculation: (PnL / (Entry Price * Qty)) * 100
                const avgRoi = stratLogs.length > 0 
                  ? (stratLogs.reduce((sum, l) => {
                      const cost = l.entry_price * l.qty;
                      return sum + (cost > 0 ? (l.pnl / cost) * 100 : 0);
                    }, 0) / stratLogs.length).toFixed(2)
                  : "0.00";

                // Description from metadata (fallback if not loaded yet)
                const meta = strategyMetadata.find(m => m.id === strat.strategy);
                const description = meta?.description || "Strategic execution layer focused on volatility and volume nodes.";

                return (
                  <div className="relative group" {...swipeHandlers}>
                    <div className="p-4 rounded-3xl border dark:bg-black/40 bg-white border dark:border-white/10 border-slate-200 text-left transition-all relative overflow-hidden flex flex-col gap-4">
                      <div className={`absolute top-0 left-0 w-full h-1 transition-colors ${strat.is_active ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`} />
                      
                      <div className="flex justify-between items-start">
                          <div className="flex flex-col">
                            <span className={`text-[13px] font-black uppercase tracking-tighter ${strat.is_active ? 'dark:text-white text-slate-900' : 'text-slate-500'}`}>
                              {strat.strategy.replace('_V1','').replace(/_/g, ' ')}
                            </span>
                            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">
                              {strat.execution_mode || 'PAPER'} MODE
                            </span>
                          </div>
                          
                          <div className="flex gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); openStrategyEditor(strat); }}
                              className="p-2 rounded-xl border transition-colors bg-indigo-500/10 border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20"
                              title="Edit Parameters"
                            >
                              <Settings size={14} />
                            </button>
                            
                            <button 
                                onClick={(e) => { e.stopPropagation(); handleToggleStrategy(strat.id, strat.is_active); }}
                                className={`p-2 rounded-xl border transition-colors ${strat.is_active ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30' : 'bg-slate-800 border-white/5 text-slate-500 hover:bg-slate-700'}`}
                                title={strat.is_active ? "Pause Strategy" : "Activate Strategy"}
                            >
                                <Power size={14} />
                            </button>
                          </div>
                      </div>

                      <p className="text-[10px] text-slate-400 leading-relaxed italic line-clamp-3">
                        &quot;{description}&quot;
                      </p>

                      <div className="grid grid-cols-2 gap-3 mt-2">
                        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-1">Realized PnL</span>
                          <span className={`text-[12px] font-mono font-black ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            ${totalPnL.toFixed(2)}
                          </span>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3">
                          <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-1">Realized ROI</span>
                          <span className={`text-[12px] font-mono font-black ${parseFloat(avgRoi) >= 0 ? 'text-cyan-400' : 'text-amber-400'}`}>
                            {avgRoi}%
                          </span>
                        </div>
                      </div>

                      {currentAssetStrategies.length > 1 && (
                        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
                          <button 
                            onClick={(e) => { e.stopPropagation(); setCurrentStrategyIndex(prev => (prev - 1 + currentAssetStrategies.length) % currentAssetStrategies.length); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
                          >
                            <ChevronDown size={16} className="rotate-90" />
                          </button>
                          <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">
                            {currentStrategyIndex + 1} / {currentAssetStrategies.length}
                          </span>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setCurrentStrategyIndex(prev => (prev + 1) % currentAssetStrategies.length); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
                          >
                            <ChevronDown size={16} className="-rotate-90" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
            })()}
          </div>

          <div id="session-logs" className="dark:bg-slate-950 bg-white border dark:border-white/10 border-slate-300/50 rounded-2xl sm:rounded-[2.5rem] flex flex-col overflow-hidden shadow-2xl min-h-[300px] max-h-[min(400px, calc(100vh - 200px))]">
            <div className="px-6 py-4 border-b dark:border-white/5 border-slate-300/50 text-[10px] font-black uppercase dark:text-slate-500 text-slate-600 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2"><TerminalIcon size={14} className="text-indigo-400" /> Session Logs</div>
              <select
                value={sessionLogAgentFilter}
                onChange={(e) => setSessionLogAgentFilter(e.target.value)}
                className="dark:bg-slate-800/50 bg-white border dark:border-white/10 border-slate-300 rounded-lg px-2 py-1 text-[9px] font-bold dark:text-slate-300 text-slate-600 outline-none focus:ring-1 focus:ring-indigo-500/50"
              >
                <option value="ALL">All Agents</option>
                <option value="Sniper">Sniper</option>
                <option value="Watchdog">Watchdog</option>
                <option value="Agent Cortex">Agent Cortex</option>
              </select>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-2 max-h-[250px] sm:max-h-full dark:text-slate-400 text-slate-600">
                {sessionLogs.filter(log => sessionLogAgentFilter === 'ALL' || log.agent_name === sessionLogAgentFilter).length === 0 ? (
                    <div className="text-slate-600 italic">Awaiting agent activity...</div>
                ) : (
                    sessionLogs.filter(log => sessionLogAgentFilter === 'ALL' || log.agent_name === sessionLogAgentFilter).filter(log => normalizeAssetSymbol(log.asset) === normalizeAssetSymbol(activeAsset)).map((log, i) => {
                        const agentColor = 
                            log.agent_name === 'Sniper' ? 'text-emerald-400' : 
                            log.agent_name === 'Watchdog' ? 'text-rose-400' : 
                            log.agent_name === 'Agent Cortex' ? 'text-indigo-400' : 'text-slate-500';
                        
                        return (
                            <div key={i} className="flex flex-col border-l-2 border-white/5 pl-3 py-1 hover:bg-white/[0.02] transition-colors">
                                <span className={`text-[8px] font-black uppercase tracking-tighter ${agentColor}`}>
                                    {new Date(log.timestamp).toLocaleTimeString()} - {log.agent_name}
                                </span>
                                <span className="text-[9px] dark:text-white/70 text-slate-700 whitespace-pre-wrap leading-relaxed">{log.log_message}</span>
                            </div>
                        );
                    })
                )}
            </div>
          </div>
          <div id="nexus-chat" className="dark:bg-slate-950 bg-white border dark:border-white/10 border-slate-300/50 rounded-2xl sm:rounded-[2.5rem] flex flex-col flex-grow overflow-hidden shadow-2xl min-h-[500px]">
          <div className="px-6 py-4 border-b dark:border-white/5 border-slate-300/50 text-[10px] font-black uppercase dark:text-slate-500 text-slate-600 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalIcon size={14} className="text-indigo-400" />
                {!riskAssessmentComplete ? (
                  <span className="text-amber-400">⚡ Risk Profile Setup</span>
                ) : (
                  <span>Nexus Agent</span>
                )}
              </div>
              <button
                onClick={() => {
                  setMessages([]);
                  sessionStorage.removeItem('nexus_chat_history');
                }}
                className="text-[9px] font-bold text-slate-500 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-red-500/10"
                title="Clear conversation history"
              >
                Clear
              </button>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar font-mono text-xs space-y-4 flex-grow">
              {messages.map(m => (
                <div key={m.id} className={`flex flex-col gap-2 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {m.toolInvocations && m.toolInvocations.map(tool => (
                        <div key={tool.toolCallId} className="text-[9px] text-slate-500 italic bg-black/30 px-3 py-1.5 rounded-lg border border-white/5 flex items-center gap-2">
                            {tool.state === 'result' ? <span className="text-emerald-400 font-bold">✓</span> : <Cpu size={10} className="animate-spin text-indigo-400" />}
                            <span>Nexus executing: <span className="font-bold text-slate-400">{tool.toolName}</span></span>
                        </div>
                    ))}
                    {m.content && (
                        <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${m.role === 'user' ? 'dark:bg-indigo-500/10 bg-indigo-100 dark:text-indigo-300 text-indigo-800 dark:border-indigo-500/20 border-indigo-300/50' : 'dark:bg-slate-900/80 bg-slate-100 dark:text-cyan-400 text-cyan-800 dark:border-white/5 border-slate-300/50'}`}>
                            {m.content}
                        </div>
                    )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleManualSubmit} className="p-4 border-t dark:border-white/5 border-slate-300/50 dark:bg-slate-900/40 bg-slate-100 flex gap-3">
                <input 
                  className="w-full dark:bg-black/50 bg-white dark:border-white/10 border-slate-300/50 rounded-xl px-4 py-3 text-[11px] font-mono dark:text-white text-slate-900 focus:outline-none focus:border-indigo-500/50" 
                  value={localInput} 
                  onChange={(e) => setLocalInput(e.target.value)} 
                  placeholder="Command Nexus..." 
                />
              <button type="submit" disabled={!localInput?.trim() || isLoading} className={`border rounded-xl px-4 py-3 transition-all flex items-center justify-center min-w-[50px] ${isLoading ? 'bg-indigo-500/40 border-indigo-500/50 text-indigo-200 animate-pulse' : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/30'}`}>
                  {isLoading ? <span className="text-[10px] font-black tracking-widest">...</span> : <Send size={16} />}
              </button>
            </form>
          </div>
        </div>
      </main>

      {/* Quick Start Guide — Coach Marks */}
          {tenantId && !quickStartDismissed && (
        <QuickStartGuide
          ref={quickStartRef}
          tenantId={tenantId}
          onBeforeStep={(prevStep, nextStep) => {
            // Step 1 (index 0): Open mobile menu so #dashboard-header is visible
            if (typeof window !== 'undefined' && window.innerWidth < 768) {
              if (nextStep === 0) setShowMobileMenu(true);
              if (prevStep === 0 && nextStep !== 2) setShowMobileMenu(false);
            }
            // Step 3 (index 2): Open market scanner so #market-scanner is visible
            if (nextStep === 2) setShowScanner(true);
            if (prevStep === 2) setShowScanner(false);
          }}
          onAfterStep={(currentStep) => {
            // Ensure mobile menu is closed after leaving Step 1 (except when moving to Step 2)
            if (typeof window !== 'undefined' && window.innerWidth < 768 && currentStep !== 0 && currentStep !== 2) {
              setShowMobileMenu(false);
            }
            // Ensure market scanner stays open during Step 3
            if (currentStep !== 2) setShowScanner(false);
          }}
          onInitialize={(currentStep) => {
            // Initialize state for the current step when guide first mounts
            if (typeof window !== 'undefined' && window.innerWidth < 768 && currentStep === 0) {
              setShowMobileMenu(true);
            }
            if (currentStep === 2) {
              setShowScanner(true);
            }
          }}
          onDismiss={async () => {
            setQuickStartDismissed(true);
            // Save dismissed state via authenticated API
            try {
              await fetch('/api/quick-start', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': session?.access_token ? `Bearer ${session.access_token}` : ''
                },
                body: JSON.stringify({ dismissed: true, step: 0 })
              });
            } catch (e) {
              console.error('[QUICKSTART] Failed to save dismissed state:', e);
            }
          }}
          onComplete={async () => {
            setQuickStartDismissed(true);
            try {
              await fetch('/api/quick-start', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': session?.access_token ? `Bearer ${session.access_token}` : ''
                },
                body: JSON.stringify({ dismissed: true, step: 8 })
              });
            } catch (e) {
              console.error('[QUICKSTART] Failed to save completion:', e);
            }
          }}
        />
      )}

      {/* Mobile Chat Notification */}
      <ChatNotification
        chatSelector="#nexus-chat"
        isOnboarding={!riskAssessmentComplete}
      />

      {/* Strategy Edit Modal */}
      {editModalOpen && editingStrategy && (
        <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-black uppercase text-white">Edit Strategy</h2>
              <button
                onClick={() => setEditModalOpen(false)}
                className="p-1 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X size={18} className="text-slate-400" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Strategy Name */}
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
                  Strategy
                </label>
                <div className="bg-slate-800 border border-white/5 rounded-lg px-3 py-2 text-white text-[10px] font-bold">
                  {editingStrategy.strategy.replace('_V1', '')}
                </div>
              </div>

              {/* Execution Mode */}
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
                  Execution Mode
                </label>
                <select
                  value={editingExecutionMode}
                  onChange={(e) => setEditingExecutionMode(e.target.value)}
                  className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-[10px] font-bold outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="PAPER">Paper Trading</option>
                  <option value="LIVE">Live Trading</option>
                </select>
              </div>

              {/* Parameters */}
              {Object.keys(editingParameters).length > 0 ? (
                <div className="border-t border-white/5 pt-4">
                  <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Parameters</h3>
                  <div className="space-y-3">
                    {Object.entries(editingParameters).map(([key, value]) => {
                      const isTimeframe = key.toLowerCase().includes('_tf') || key.toLowerCase().includes('timeframe');
                      const timeframeOptions = ['1m', '5m', '15m', '30m', '1hr', '2hr', '4hr', '1d'];
                      
                      return (
                        <div key={key}>
                          <label className="text-[9px] font-black text-slate-600 uppercase tracking-widest block mb-1">
                            {value.label || key}
                          </label>
                          {isTimeframe ? (
                            <select
                              value={editingParameters[key].default}
                              onChange={(e) => setEditingParameters(prev => ({
                                ...prev,
                                [key]: { ...prev[key], default: e.target.value }
                              }))}
                              className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-[9px] outline-none focus:ring-1 focus:ring-indigo-500/50"
                            >
                              <option value="">Select Timeframe</option>
                              {timeframeOptions.map(tf => (
                                <option key={tf} value={tf}>{tf}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={value.type}
                              value={editingParameters[key].default}
                              onChange={(e) => setEditingParameters(prev => ({
                                ...prev,
                                [key]: { ...prev[key], default: value.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value }
                              }))}
                              className="w-full bg-slate-800 border border-white/5 rounded-lg px-3 py-2 text-white text-[9px] outline-none focus:ring-1 focus:ring-indigo-500/50"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="text-center py-4 text-slate-600 text-[9px] italic">
                  No parameters to configure
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 border-t border-white/5 pt-4 mt-4">
                <button
                  onClick={() => setEditModalOpen(false)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all border border-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={saveStrategyChanges}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all shadow-lg shadow-indigo-500/20"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Profile Settings Modal */}
      {showProfileModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowProfileModal(false)}>
          <div className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-black uppercase tracking-wider">Profile Settings</h2>
              <button onClick={() => setShowProfileModal(false)} className="text-slate-500 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1 block">Full Name</label>
                <input
                  type="text"
                  value={profileFullName}
                  onChange={e => setProfileFullName(e.target.value)}
                  className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all placeholder:text-slate-700"
                  placeholder="Your name"
                />
              </div>

              <div className="border-t border-white/5 pt-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-3">Coinbase API Keys</h3>
                <p className="text-[9px] text-amber-400/80 mb-3 italic">🔒 Keys are encrypted with AES-256 before storage. Never share them with anyone.</p>
                <div className="space-y-3">
                  <input
                    id="api-key-name-input"
                    type="text"
                    value={profileApiKey}
                    onChange={e => setProfileApiKey(e.target.value)}
                    className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all placeholder:text-slate-700"
                    placeholder="organizations/..."
                  />
                  <input
                    id="api-secret-input"
                    type="password"
                    value={profileApiSecret}
                    onChange={e => setProfileApiSecret(e.target.value)}
                    className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all placeholder:text-slate-700"
                    placeholder="-----BEGIN EC PRIVATE KEY-----"
                  />
                </div>
              </div>

              <div className="border-t border-white/5 pt-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-emerald-400 mb-3">Discord Webhook</h3>
                <input
                  type="url"
                  value={profileWebhookUrl}
                  onChange={e => setProfileWebhookUrl(e.target.value)}
                  className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all placeholder:text-slate-700"
                  placeholder="https://discord.com/api/webhooks/..."
                />
              </div>

              {/* Risk Profile Preview (read-only) */}
              <div className="border-t border-white/5 pt-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-400 mb-3">⚡ Risk Profile</h3>
                {riskPreview ? (
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Balance</span>
                      <span className="text-white font-bold font-mono">${riskPreview.account_balance_usd?.toLocaleString() || '--'}</span>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Risk / Trade</span>
                      <span className="text-white font-bold font-mono">{riskPreview.risk_per_trade_percent || '--'}%</span>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Max Position</span>
                      <span className="text-white font-bold font-mono">${riskPreview.max_position_size_usd?.toLocaleString() || '--'}</span>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Max Leverage</span>
                      <span className="text-white font-bold font-mono">{riskPreview.max_leverage || '--'}x</span>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Daily ROI Target</span>
                      <span className="text-white font-bold font-mono">${riskPreview.daily_roi_target_usd?.toLocaleString() || '--'}</span>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-2">
                      <span className="text-[8px] text-slate-500 uppercase tracking-widest font-black block">Max Trades</span>
                      <span className="text-white font-bold font-mono">{riskPreview.max_concurrent_trades || '--'}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[9px] text-slate-500 italic">No risk profile configured yet.</p>
                )}
                <Link
                  href="/settings"
                  className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 font-black text-[9px] uppercase tracking-widest py-2 rounded-lg transition-all"
                >
                  ⚙️ Edit in Settings →
                </Link>
              </div>

              {profileMessage && (
                <p className="text-xs text-emerald-400 font-medium">{profileMessage}</p>
              )}

              <button
                id="api-key-save-btn"
                onClick={async () => {
                  setProfileSaving(true);
                  setProfileMessage('');
                  try {
                    if (profileApiKey && profileApiSecret) {
                      const keyRes = await fetch('/api/configure-api-keys', {
                        method: 'POST',
                        headers: { 
                          'Content-Type': 'application/json',
                          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : ''
                        },
                        body: JSON.stringify({ exchange: 'coinbase', apiKey: profileApiKey, apiSecret: profileApiSecret })
                      });
                      if (!keyRes.ok) throw new Error('Failed to save API keys');
                    }
                    if (profileWebhookUrl) {
                      const webhookRes = await fetch('/api/configure-tenant-settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ notification_webhook_url: profileWebhookUrl })
                      });
                      if (!webhookRes.ok) throw new Error('Failed to save webhook');
                    }
                    setProfileMessage('Settings saved successfully.');
                    setTimeout(() => setShowProfileModal(false), 1500);
                  } catch (err) {
                    setProfileMessage(`Error: ${err.message}`);
                  } finally {
                    setProfileSaving(false);
                  }
                }}
                disabled={profileSaving}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {profileSaving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarding Tour */}
      {showOnboarding && onboardingSteps[onboardingStep] && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-4 sm:p-6 w-[calc(100vw-32px)] max-w-md mx-4 shadow-2xl shadow-[0_0_40px_rgba(99,102,241,0.3)] pointer-events-auto overflow-x-hidden break-words">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                <Zap className="w-5 h-5 text-indigo-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400">Step {onboardingStep + 1} of {onboardingSteps.length}</p>
                <h3 className="text-lg font-bold text-white break-words">{onboardingSteps[onboardingStep].title}</h3>
              </div>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed mb-8 break-words">{onboardingSteps[onboardingStep].desc}</p>
            <div className="flex justify-between items-center gap-2 flex-wrap">
              <button
                onClick={() => {
                  localStorage.setItem('nexus_onboarding_completed', 'true');
                  setShowOnboarding(false);
                }}
                className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
              >
                Skip Tour
              </button>
              <div className="flex gap-2 flex-wrap">
                {onboardingStep > 0 && (
                  <button
                    onClick={() => setOnboardingStep(s => s - 1)}
                    className="text-[10px] font-black uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg transition-colors"
                  >
                    Back
                  </button>
                )}
                {onboardingSteps[onboardingStep].action ? (
                  <a
                    href={onboardingSteps[onboardingStep].actionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-black uppercase tracking-widest bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-4 py-2 rounded-lg transition-all hover:-translate-y-0.5"
                    onClick={() => {
                      if (onboardingStep < onboardingSteps.length - 1) {
                        setOnboardingStep(s => s + 1);
                      } else {
                        localStorage.setItem('nexus_onboarding_completed', 'true');
                        setShowOnboarding(false);
                      }
                    }}
                  >
                    {onboardingSteps[onboardingStep].actionLabel}
                  </a>
                ) : (
                  <button
                    onClick={() => {
                      if (onboardingStep < onboardingSteps.length - 1) {
                        setOnboardingStep(s => s + 1);
                      } else {
                        localStorage.setItem('nexus_onboarding_completed', 'true');
                        setShowOnboarding(false);
                      }
                    }}
                    className="text-[10px] font-black uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-all"
                  >
                    {onboardingStep < onboardingSteps.length - 1 ? 'Next' : 'Get Started'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}