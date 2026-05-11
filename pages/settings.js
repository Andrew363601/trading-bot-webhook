// pages/settings.js
import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { Shield, Key, CheckCircle2, AlertCircle, ArrowLeft, Save } from 'lucide-react';
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

    // Fetch existing settings on component mount
    useEffect(() => {
        const fetchSettings = async () => {
            setLoading(true);
            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;

                // Fetch API Keys
                const { data: apiKeys, error: keysError } = await supabase
                    .from('api_keys_vault')
                    .select('exchange, key_encrypted, secret_encrypted')
                    .eq('tenant_id', session.user.id) // Assuming tenant_id == auth_user_id for now
                    .single();
                if (keysError && keysError.code !== 'PGRST116') throw keysError; // PGRST116 means no rows found, which is fine
                if (apiKeys) {
                    setExchange(apiKeys.exchange);
                }

                // Fetch Tenant Settings for webhook URL
                const { data: tenantSettings, error: settingsError } = await supabase
                    .from('tenant_settings')
                    .select('notification_webhook_url')
                    .eq('tenant_id', session.user.id) // Assuming tenant_id == auth_user_id for now
                    .single();
                if (settingsError && settingsError.code !== 'PGRST116') throw settingsError;
                if (tenantSettings) {
                    setDiscordWebhookUrl(tenantSettings.notification_webhook_url || '');
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
