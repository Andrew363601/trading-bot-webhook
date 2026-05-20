// pages/settings.js
import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { Shield, Key, CheckCircle2, AlertCircle, ArrowLeft, Save, BrainCircuit } from 'lucide-react';
import Link from 'next/link';
import AuthGuard from '../components/AuthGuard';
import { useSupabaseClient } from '@supabase/auth-helpers-react';

export default function Settings() {
    return (
        <AuthGuard>
            <SettingsContent />
        </AuthGuard>
    );
}

function SettingsContent() {
    const supabase = useSupabaseClient();
    const [exchange, setExchange] = useState('COINBASE');
    const [apiKey, setApiKey] = useState('');
    const [apiSecret, setApiSecret] = useState('');
    const [discordWebhookUrl, setDiscordWebhookUrl] = useState(''); // New state for Discord webhook
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);

    // Risk profile state
    const [riskFields, setRiskFields] = useState({
        accountBalance: '',
        riskPerTrade: '',
        maxPositionSize: '',
        maxLeverage: '',
        dailyRoiTarget: '',
        maxConcurrentTrades: ''
    });
    const [riskSaving, setRiskSaving] = useState(false);
    const [tenantId, setTenantId] = useState(null);

    // Agent settings state
    const [agentSettings, setAgentSettings] = useState({
        openTradeEnabled: false,
        openTradeReverse: false,
        openTradeClose: false,
        openTradeAdjustTpSl: false,
        openTradeTripwireAdjust: false,
        takerFeeRate: '0.08'
    });
    const [agentSaving, setAgentSaving] = useState(false);

    // Fetch existing settings on component mount
    useEffect(() => {
        const fetchSettings = async () => {
            setLoading(true);
            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;

                // Fetch API Keys — resolve tenant_id via tenant_users first
                const { data: userLink } = await supabase
                    .from('tenant_users')
                    .select('tenant_id')
                    .eq('auth_user_id', session.user.id)
                    .single();

                const actualTenantId = userLink?.tenant_id || session.user.id;
                setTenantId(actualTenantId);

                const { data: apiKeys, error: keysError } = await supabase
                    .from('api_keys_vault')
                    .select('exchange, key_encrypted, secret_encrypted')
                    .eq('tenant_id', actualTenantId)
                    .single();
                if (keysError && keysError.code !== 'PGRST116') throw keysError;
                if (apiKeys) {
                    setExchange(apiKeys.exchange);
                }

                // Fetch Tenant Settings for webhook URL + risk profile
                const { data: tenantSettings, error: settingsError } = await supabase
                    .from('tenant_settings')
                    .select('*')
                    .eq('tenant_id', actualTenantId)
                    .single();
                if (settingsError && settingsError.code !== 'PGRST116') throw settingsError;
                if (tenantSettings) {
                    setDiscordWebhookUrl(tenantSettings.notification_webhook_url || '');
                    // Pre-populate risk fields
                    setRiskFields({
                        accountBalance: tenantSettings.account_balance_usd?.toString() || '',
                        riskPerTrade: tenantSettings.risk_per_trade_percent?.toString() || '',
                        maxPositionSize: tenantSettings.max_position_size_usd?.toString() || '',
                        maxLeverage: tenantSettings.max_leverage?.toString() || '',
                        dailyRoiTarget: tenantSettings.daily_roi_target_usd?.toString() || '',
                        maxConcurrentTrades: tenantSettings.max_concurrent_trades?.toString() || ''
                    });
                    // Pre-populate agent settings
                    setAgentSettings({
                        openTradeEnabled: tenantSettings.agent_open_trade_enabled || false,
                        openTradeReverse: tenantSettings.agent_open_trade_reverse || false,
                        openTradeClose: tenantSettings.agent_open_trade_close || false,
                        openTradeAdjustTpSl: tenantSettings.agent_open_trade_adjust_tp_sl || false,
                        openTradeTripwireAdjust: tenantSettings.agent_open_trade_tripwire_adjust || false,
                        takerFeeRate: tenantSettings.agent_taker_fee_rate?.toString() || '0.08'
                    });
                }

            } catch (err) {
                console.error("Failed to fetch settings:", err.message);
                setStatus({ type: 'error', message: `Failed to load settings: ${err.message}` });
            } finally {
                setLoading(false);
            }
        };
        fetchSettings();
    }, [supabase]);

    // Handle API Key submission
    const handleSubmitApiKeys = async (e) => {
        e.preventDefault();
        setLoading(true);
        setStatus(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");
            
            const response = await fetch('/api/configure-api-keys', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ exchange, apiKey, apiSecret })
            });

            const result = await response.json();
            if (response.ok) {
                setStatus({ type: 'success', message: `Vault Updated: ${exchange} keys secured.` });
                setApiKey('');
                setApiSecret('');
            } else {
                throw new Error(result.error || 'Failed to update keys');
            }
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        } finally {
            setLoading(false);
        }
    };

    // Handle Risk Profile submission
    const handleSaveRiskProfile = async () => {
        setRiskSaving(true);
        setStatus(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");

            const response = await fetch('/api/configure-tenant-settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    account_balance_usd: parseFloat(riskFields.accountBalance) || null,
                    risk_per_trade_percent: parseFloat(riskFields.riskPerTrade) || null,
                    max_position_size_usd: parseFloat(riskFields.maxPositionSize) || null,
                    max_leverage: parseFloat(riskFields.maxLeverage) || null,
                    daily_roi_target_usd: parseFloat(riskFields.dailyRoiTarget) || null,
                    max_concurrent_trades: parseInt(riskFields.maxConcurrentTrades) || null
                })
            });

            const result = await response.json();
            if (response.ok) {
                setStatus({ type: 'success', message: 'Risk profile updated successfully.' });
            } else {
                throw new Error(result.error || 'Failed to update risk profile');
            }
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        } finally {
            setRiskSaving(false);
        }
    };

    // Handle Agent Settings submission
    const handleSaveAgentSettings = async () => {
        setAgentSaving(true);
        setStatus(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");

            const response = await fetch('/api/configure-tenant-settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    agent_open_trade_enabled: agentSettings.openTradeEnabled,
                    agent_open_trade_reverse: agentSettings.openTradeReverse,
                    agent_open_trade_close: agentSettings.openTradeClose,
                    agent_open_trade_adjust_tp_sl: agentSettings.openTradeAdjustTpSl,
                    agent_open_trade_tripwire_adjust: agentSettings.openTradeTripwireAdjust,
                    agent_taker_fee_rate: parseFloat(agentSettings.takerFeeRate) / 100 || 0.0008
                })
            });

            const result = await response.json();
            if (response.ok) {
                setStatus({ type: 'success', message: 'Agent settings updated successfully.' });
            } else {
                throw new Error(result.error || 'Failed to update agent settings');
            }
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        } finally {
            setAgentSaving(false);
        }
    };

    // Handle Quick Start Tour
    const handleRestartTour = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");

            const response = await fetch('/api/configure-tenant-settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    quick_start_dismissed: false,
                    quick_start_step: 0
                })
            });

            if (!response.ok) throw new Error('Failed to reset tour');

            setStatus({ type: 'success', message: 'Quick Start Guide will appear on your next dashboard visit.' });
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        }
    };

    const handleDismissTour = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");

            const response = await fetch('/api/configure-tenant-settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    quick_start_dismissed: true
                })
            });

            if (!response.ok) throw new Error('Failed to dismiss tour');

            setStatus({ type: 'success', message: 'Quick Start Guide dismissed.' });
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        }
    };

    // Handle Notification Settings submission
    const handleSubmitNotifications = async (e) => {
        e.preventDefault();
        setLoading(true);
        setStatus(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No active session");

            const response = await fetch('/api/configure-tenant-settings', { // New API endpoint for tenant settings
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ notification_webhook_url: discordWebhookUrl })
            });

            const result = await response.json();
            if (response.ok) {
                setStatus({ type: 'success', message: 'Notification settings updated.' });
            } else {
                throw new Error(result.error || 'Failed to update notification settings');
            }
        } catch (err) {
            setStatus({ type: 'error', message: err.message });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 text-white p-8">
            <Head><title>Nexus | Security Vault</title></Head>

            <div className="max-w-2xl mx-auto space-y-8 mt-12">
                <Link href="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-white transition-colors text-xs font-black uppercase tracking-widest">
                    <ArrowLeft className="w-4 h-4" /> Back to Dashboard
                </Link>

                <header>
                    <h1 className="text-4xl font-black italic tracking-tighter uppercase">Security Vault</h1>
                    <p className="text-slate-400 mt-2">Configure your exchange credentials. All keys are AES-256 encrypted before storage.</p>
                </header>

                <form onSubmit={handleSubmitApiKeys} className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
                    <div className="flex items-center gap-3 mb-2">
                        <Key className="w-5 h-5 text-indigo-400" />
                        <h2 className="text-xl font-black uppercase tracking-tight">Exchange Keys</h2>
                    </div>
                    
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Exchange Provider</label>
                        <select 
                            value={exchange}
                            onChange={(e) => setExchange(e.target.value)}
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all"
                        >
                            <option value="COINBASE">Coinbase Advanced Trade</option>
                        </select>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">API Key (Name)</label>
                        <input
                            type="text"
                            required
                            placeholder="organizations/..."
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">API Secret (Private Key)</label>
                        <textarea
                            required
                            rows={4}
                            placeholder="-----BEGIN ANY PRIVATE KEY-----"
                            value={apiSecret}
                            onChange={(e) => setApiSecret(e.target.value)}
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                        />
                    </div>

                    <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-2xl flex gap-3">
                        <Shield className="w-5 h-5 text-indigo-400 shrink-0" />
                        <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                            Nexus uses a split-key encryption model. Your keys are encrypted with your unique Tenant ID and a hardware-protected master key. Not even Nexus administrators can view your raw secrets.
                        </p>
                    </div>

                    <button 
                        disabled={loading}
                        type="submit"
                        className="w-full bg-white text-black hover:bg-slate-200 font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest"
                    >
                        {loading ? <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                        Commit Keys to Vault
                    </button>
                </form>

                <form onSubmit={handleSubmitNotifications} className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
                    <div className="flex items-center gap-3 mb-2">
                        <AlertCircle className="w-5 h-5 text-indigo-400" />
                        <h2 className="text-xl font-black uppercase tracking-tight">Notifications</h2>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Discord Webhook URL</label>
                        <input
                            type="url"
                            placeholder="https://discord.com/api/webhooks/..."
                            value={discordWebhookUrl}
                            onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                        />
                        <p className="text-[9px] text-slate-500 ml-1 italic">Signals, Executions, and Autopsies will be pushed to this channel.</p>
                    </div>

                    <button 
                        disabled={loading}
                        type="submit"
                        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest shadow-lg shadow-indigo-500/20"
                    >
                        {loading ? <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Update Notifications
                    </button>
                </form>

                {/* Risk Profile Section */}
                <div className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
                    <div className="flex items-center gap-3 mb-2">
                        <Shield className="w-5 h-5 text-amber-400" />
                        <h2 className="text-xl font-black uppercase tracking-tight">Risk Profile</h2>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Account Balance (USD)</label>
                            <input
                                type="number"
                                placeholder="5000"
                                value={riskFields.accountBalance}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, accountBalance: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Risk Per Trade (%)</label>
                            <input
                                type="number"
                                step="0.1"
                                placeholder="2.0"
                                value={riskFields.riskPerTrade}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, riskPerTrade: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Max Position Size (USD)</label>
                            <input
                                type="number"
                                placeholder="5000"
                                value={riskFields.maxPositionSize}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, maxPositionSize: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Max Leverage (1-100x)</label>
                            <input
                                type="number"
                                placeholder="10"
                                value={riskFields.maxLeverage}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, maxLeverage: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Daily ROI Target (USD)</label>
                            <input
                                type="number"
                                placeholder="1000"
                                value={riskFields.dailyRoiTarget}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, dailyRoiTarget: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Max Concurrent Trades</label>
                            <input
                                type="number"
                                placeholder="3"
                                value={riskFields.maxConcurrentTrades}
                                onChange={(e) => setRiskFields(prev => ({ ...prev, maxConcurrentTrades: e.target.value }))}
                                className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all font-mono text-sm"
                            />
                        </div>
                    </div>

                    <button
                        onClick={handleSaveRiskProfile}
                        disabled={riskSaving}
                        className="w-full bg-amber-600 hover:bg-amber-500 text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest shadow-lg shadow-amber-500/20"
                    >
                        {riskSaving ? <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Risk Profile
                    </button>
                </div>

                {/* Agent Settings Section */}
                <div className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
                    <div className="flex items-center gap-3 mb-2">
                        <BrainCircuit className="w-5 h-5 text-purple-400" />
                        <h2 className="text-xl font-black uppercase tracking-tight">Agent Settings</h2>
                    </div>

                    <div className="bg-slate-950/50 border border-white/5 rounded-2xl p-5 space-y-4">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Active Trade Management</h3>
                        
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="text-sm font-bold text-white group-hover:text-purple-300 transition-colors">Enable Active Trade Re-Evaluation</span>
                            <input
                                type="checkbox"
                                checked={agentSettings.openTradeEnabled}
                                onChange={(e) => setAgentSettings(prev => ({ ...prev, openTradeEnabled: e.target.checked }))}
                                className="toggle toggle-purple"
                            />
                        </label>

                        {agentSettings.openTradeEnabled && (
                            <div className="ml-4 pl-4 border-l border-white/10 space-y-3">
                                <label className="flex items-center justify-between cursor-pointer group">
                                    <span className="text-xs font-bold text-slate-400 group-hover:text-purple-300 transition-colors">Allow Position Reversal</span>
                                    <input
                                        type="checkbox"
                                        checked={agentSettings.openTradeReverse}
                                        onChange={(e) => setAgentSettings(prev => ({ ...prev, openTradeReverse: e.target.checked }))}
                                        className="toggle toggle-purple"
                                    />
                                </label>
                                <label className="flex items-center justify-between cursor-pointer group">
                                    <span className="text-xs font-bold text-slate-400 group-hover:text-purple-300 transition-colors">Allow Early Close (Profit/Loss)</span>
                                    <input
                                        type="checkbox"
                                        checked={agentSettings.openTradeClose}
                                        onChange={(e) => setAgentSettings(prev => ({ ...prev, openTradeClose: e.target.checked }))}
                                        className="toggle toggle-purple"
                                    />
                                </label>
                                <label className="flex items-center justify-between cursor-pointer group">
                                    <span className="text-xs font-bold text-slate-400 group-hover:text-purple-300 transition-colors">Allow TP/SL Adjustment</span>
                                    <input
                                        type="checkbox"
                                        checked={agentSettings.openTradeAdjustTpSl}
                                        onChange={(e) => setAgentSettings(prev => ({ ...prev, openTradeAdjustTpSl: e.target.checked }))}
                                        className="toggle toggle-purple"
                                    />
                                </label>
                                <label className="flex items-center justify-between cursor-pointer group">
                                    <span className="text-xs font-bold text-slate-400 group-hover:text-purple-300 transition-colors">Allow Tripwire/Trailing Stop Adjustment</span>
                                    <input
                                        type="checkbox"
                                        checked={agentSettings.openTradeTripwireAdjust}
                                        onChange={(e) => setAgentSettings(prev => ({ ...prev, openTradeTripwireAdjust: e.target.checked }))}
                                        className="toggle toggle-purple"
                                    />
                                </label>
                            </div>
                        )}
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                            Taker Fee Rate (%)
                            <span className="text-[8px] text-slate-600 font-normal normal-case italic">Used for R:R cost calculations</span>
                        </label>
                        <input
                            type="number"
                            step="0.001"
                            placeholder="0.08"
                            value={agentSettings.takerFeeRate}
                            onChange={(e) => setAgentSettings(prev => ({ ...prev, takerFeeRate: e.target.value }))}
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-purple-500/50 outline-none transition-all font-mono text-sm"
                        />
                    </div>

                    <button
                        onClick={handleSaveAgentSettings}
                        disabled={agentSaving}
                        className="w-full bg-purple-600 hover:bg-purple-500 text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest shadow-lg shadow-purple-500/20"
                    >
                        {agentSaving ? <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Agent Settings
                    </button>
                </div>

                {/* Quick Start Guide Section */}
                <div className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
                    <div className="flex items-center gap-3 mb-2">
                        <AlertCircle className="w-5 h-5 text-cyan-400" />
                        <h2 className="text-xl font-black uppercase tracking-tight">Quick Start Guide</h2>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                        The Quick Start Guide shows coach marks over the dashboard to help you learn the interface.
                    </p>
                    <div className="flex gap-4">
                        <button
                            onClick={handleRestartTour}
                            className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest shadow-lg shadow-cyan-500/20"
                        >
                            Restart Tour
                        </button>
                        <button
                            onClick={handleDismissTour}
                            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest"
                        >
                            Dismiss Forever
                        </button>
                    </div>
                </div>

                {status && (
                    <div className={`p-4 rounded-xl border flex items-center gap-3 ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                        {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                        <span className="text-xs font-bold uppercase tracking-wide">{status.message}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
