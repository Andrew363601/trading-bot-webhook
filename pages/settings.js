// pages/settings.js
import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { createClient } from '@supabase/supabase-js';
import { Shield, Key, CheckCircle2, AlertCircle, ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import AuthGuard from '../components/AuthGuard';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function Settings() {
    return (
        <AuthGuard>
            <SettingsContent />
        </AuthGuard>
    );
}

function SettingsContent() {
    const [exchange, setExchange] = useState('COINBASE');
    const [apiKey, setApiKey] = useState('');
    const [apiSecret, setApiSecret] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setStatus(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            
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

                <form onSubmit={handleSubmit} className="bg-slate-900/50 border border-white/5 p-8 rounded-3xl space-y-6 backdrop-blur-xl">
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
                        className="w-full bg-white text-black hover:bg-slate-200 font-black py-4 rounded-xl transition-all flex items-center justify-center gap-2 uppercase text-xs tracking-widest"
                    >
                        {loading ? <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
                        Commit Keys to Vault
                    </button>

                    {status && (
                        <div className={`p-4 rounded-xl border flex items-center gap-3 ${status.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                            {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                            <span className="text-xs font-bold uppercase tracking-wide">{status.message}</span>
                        </div>
                    )}
                </form>
            </div>
        </div>
    );
}
