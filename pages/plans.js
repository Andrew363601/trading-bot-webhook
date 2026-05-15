import React, { useState, useEffect } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Zap, Check, ArrowRight } from 'lucide-react';

export default function PlansPage() {
  const session = useSession();
  const supabase = useSupabaseClient();
  const [loading, setLoading] = useState(null);
  const router = useRouter();

  useEffect(() => {
    if (session) {
      const checkSub = async () => {
        const { data } = await supabase
          .from('tenant_users')
          .select('role, tenants(billing_tier, subscription_active)')
          .eq('auth_user_id', session.user.id)
          .single();
        
        // 🛡️ ADMIN GUARD: Admins should never see the plans page
        if (data?.role === 'ADMIN') {
          router.replace('/');
          return;
        }

        // Only redirect if they have an active PAID subscription (not free trial)
        if (data?.tenants?.billing_tier && data.tenants.billing_tier !== 'FREE_TRIAL' && data?.tenants?.subscription_active) {
          router.replace('/');
        }
      };
      checkSub();
    }
  }, [session, supabase, router]);

  const handleSelectTier = async (tier) => {
    if (!session) return;
    setLoading(tier);
    try {
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          tier, 
          email: session.user.email,
          tenantId: session.user.id // This assumes tenantId maps to userId for trial init
        })
      });
      const { url, error } = await res.json();
      if (error) throw new Error(error);
      window.location.href = url;
    } catch (err) {
      alert(`Checkout failed: ${err.message}`);
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6 md:p-12">
      <Head><title>Nexus | Choose Your Arsenal</title></Head>
      
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h1 className="text-4xl md:text-6xl font-black tracking-tighter mb-4 italic uppercase">Nexus Intelligence</h1>
          <p className="text-slate-400 text-lg">Pick your execution tier. 14-day free trial included.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Retail */}
          <div className="bg-slate-900 border border-white/5 p-8 rounded-3xl flex flex-col">
            <h3 className="text-xl font-bold text-slate-400 mb-2">Retail</h3>
            <div className="text-4xl font-black mb-6">$49<span className="text-sm font-normal text-slate-500">/mo</span></div>
            <ul className="space-y-4 mb-10 flex-1">
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-cyan-400" /> 1 Active Asset</li>
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-cyan-400" /> Standard Execution</li>
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-cyan-400" /> Discord Push Alerts</li>
            </ul>
            <button 
              onClick={() => handleSelectTier('RETAIL')}
              disabled={loading}
              className="w-full py-4 bg-slate-800 hover:bg-slate-700 rounded-2xl font-bold transition-all flex items-center justify-center gap-2"
            >
              {loading === 'RETAIL' ? 'Loading...' : 'Start Trial'} <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Pro */}
          <div className="bg-slate-900 border-2 border-indigo-500/50 p-8 rounded-3xl flex flex-col relative transform md:-translate-y-4 shadow-[0_0_50px_rgba(99,102,241,0.15)]">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-indigo-600 text-[10px] font-black px-4 py-1 rounded-full uppercase tracking-widest">Most Popular</div>
            <h3 className="text-xl font-bold text-white mb-2">Pro Agent</h3>
            <div className="text-4xl font-black mb-6">$149<span className="text-sm font-normal text-slate-500">/mo</span></div>
            <ul className="space-y-4 mb-10 flex-1">
              <li className="flex items-center gap-3 text-sm text-slate-200"><Check className="w-4 h-4 text-indigo-400" /> 5 Active Assets</li>
              <li className="flex items-center gap-3 text-sm text-slate-200"><Check className="w-4 h-4 text-indigo-400" /> Agentic Reflection</li>
              <li className="flex items-center gap-3 text-sm text-slate-200"><Check className="w-4 h-4 text-indigo-400" /> High-Priority Routing</li>
              <li className="flex items-center gap-3 text-sm text-slate-200"><Check className="w-4 h-4 text-indigo-400" /> Multi-TF X-Ray</li>
            </ul>
            <button 
              onClick={() => handleSelectTier('PRO')}
              disabled={loading}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 rounded-2xl font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
            >
              {loading === 'PRO' ? 'Loading...' : 'Start Trial'} <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Institutional */}
          <div className="bg-slate-900 border border-white/5 p-8 rounded-3xl flex flex-col">
            <h3 className="text-xl font-bold text-slate-400 mb-2">Institutional</h3>
            <div className="text-4xl font-black mb-6">$499<span className="text-sm font-normal text-slate-500">/mo</span></div>
            <ul className="space-y-4 mb-10 flex-1">
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-purple-400" /> Unlimited Assets</li>
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-purple-400" /> HFT Colocation</li>
              <li className="flex items-center gap-3 text-sm text-slate-300"><Check className="w-4 h-4 text-purple-400" /> Full Order Book Depth</li>
            </ul>
            <button 
              onClick={() => handleSelectTier('INSTITUTIONAL')}
              disabled={loading}
              className="w-full py-4 bg-slate-800 hover:bg-slate-700 rounded-2xl font-bold transition-all flex items-center justify-center gap-2"
            >
              {loading === 'INSTITUTIONAL' ? 'Loading...' : 'Start Trial'} <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        <p className="mt-12 text-center text-slate-500 text-sm">
          Payment processed securely by Stripe. No charge until your 14-day trial ends.
        </p>
      </div>
    </div>
  );
}
