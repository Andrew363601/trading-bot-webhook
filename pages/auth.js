// pages/auth.js
import React, { useState, useEffect } from 'react';
import { useSupabaseClient, useSession } from '@supabase/auth-helpers-react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Zap, Mail, Github, Chrome } from 'lucide-react';

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [sessionCheckComplete, setSessionCheckComplete] = useState(false);
  const [paidPolling, setPaidPolling] = useState(false);
  const [tenantNotFound, setTenantNotFound] = useState(false);
  const router = useRouter();
  const supabase = useSupabaseClient();
  const session = useSession();
  const { paid } = router.query;

  useEffect(() => {
    // Session check for callback processing - redirect after OAuth
    const checkSession = async () => {
      try {
        const { data: { session: activeSession } } = await supabase.auth.getSession();
        
        if (activeSession) {
          // Step 1: Fetch tenant_users record (always works — no nested relationship needed)
          const { data: userData } = await supabase
            .from('tenant_users')
            .select('tenant_id, role')
            .eq('auth_user_id', activeSession.user.id)
            .single();

          if (!userData) {
            setTenantNotFound(true);
            setSessionCheckComplete(true);
            return;
          }

          const role = userData?.role;
          const tenantId = userData?.tenant_id;

          // 🛡️ ADMIN GUARD: Always redirect to dashboard regardless of billing status
          if (role === 'ADMIN') {
            router.replace('/');
            return;
          }

          // Step 2: Determine billing status from multiple sources (fallback chain)
          let billingTier = null;
          let subscriptionActive = null;

          // Source A: Try nested tenants() relationship
          if (tenantId) {
            const { data: tenantData } = await supabase
              .from('tenants')
              .select('billing_tier, subscription_active')
              .eq('id', tenantId)
              .single();

            if (tenantData) {
              billingTier = tenantData.billing_tier;
              subscriptionActive = tenantData.subscription_active;
            }

            // Source B: Fall back to subscriptions table — check if user has a Stripe customer or subscription ID
            if (!billingTier || billingTier === 'FREE_TRIAL') {
              const { data: subData } = await supabase
                .from('subscriptions')
                .select('status, tier, stripe_subscription_id, stripe_customer_id')
                .eq('tenant_id', tenantId)
                .single();

              // Paid if they have a Stripe subscription (active/trialing) OR a valid customer record
              if ((subData?.stripe_subscription_id && (subData.status === 'active' || subData.status === 'trialing')) ||
                  (subData?.stripe_customer_id && subData.stripe_customer_id !== 'undefined')) {
                billingTier = subData.tier || 'RETAIL';
                subscriptionActive = true;
              }
            }
          }

          // 🛡️ PAID POLLING: If user just came from Stripe checkout (?paid=true)
          // Poll for up to 10 seconds waiting for webhook to update billing_tier
          if (paid === 'true' && (!billingTier || billingTier === 'FREE_TRIAL')) {
            setPaidPolling(true);
            let attempts = 0;
            const poll = setInterval(async () => {
              attempts++;

              // Poll tenants table directly
              const { data: freshTenant } = await supabase
                .from('tenants')
                .select('billing_tier, subscription_active')
                .eq('id', tenantId)
                .single();

              let freshTier = freshTenant?.billing_tier;
              let freshActive = freshTenant?.subscription_active;

              // Also poll subscriptions table
              if (!freshTier || freshTier === 'FREE_TRIAL') {
                const { data: freshSub } = await supabase
                  .from('subscriptions')
                  .select('status, tier, stripe_subscription_id, stripe_customer_id')
                  .eq('tenant_id', tenantId)
                  .single();

                if ((freshSub?.stripe_subscription_id && (freshSub.status === 'active' || freshSub.status === 'trialing')) ||
                    (freshSub?.stripe_customer_id && freshSub.stripe_customer_id !== 'undefined')) {
                  freshTier = freshSub.tier || 'RETAIL';
                  freshActive = true;
                }
              }

              if (freshTier && freshTier !== 'FREE_TRIAL' && freshActive) {
                clearInterval(poll);
                setPaidPolling(false);
                router.replace('/');
                return;
              }

              if (attempts >= 10) {
                clearInterval(poll);
                setPaidPolling(false);
                setMessage('Payment confirmed but activation is delayed. Please try logging in again shortly.');
              }
            }, 1000);
            return;
          }

          // Normal redirect: TRIAL users go to plans, paid users go to dashboard
          const isPaid = billingTier && billingTier !== 'FREE_TRIAL' && subscriptionActive;
          if (isPaid) {
            router.replace('/');
          } else {
            router.replace('/plans');
          }
        }
        setSessionCheckComplete(true);
      } catch (err) {
        console.error('Session check error:', err);
        setSessionCheckComplete(true);
      }
    };

    checkSession();
  }, [supabase, router, paid]);

  const handleMagicLink = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ 
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth` } 
    });
    if (error) setMessage(error.message);
    else setMessage('Check your email for the magic login link!');
    setLoading(false);
  };

  const handleSocialLogin = async (provider) => {
    // Use production domain if deployed, otherwise localhost
    const isProduction = window.location.hostname !== 'localhost';
    const redirectTo = isProduction 
      ? 'https://trading-bot-webhook.vercel.app/auth'
      : `${window.location.origin}/auth`;
    
    await supabase.auth.signInWithOAuth({ 
      provider, 
      options: { redirectTo } 
    });
  };

  return (
    <div className="flex min-h-screen bg-slate-950 items-center justify-center p-6">
      <Head><title>Nexus | Secure Access</title></Head>
      
      <div className="w-full max-w-md space-y-8 bg-slate-900/50 border border-white/5 p-8 rounded-2xl backdrop-blur-xl">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-indigo-500/10 mb-4">
            <Zap className="w-8 h-8 text-indigo-400" />
          </div>
          <h2 className="text-3xl font-black tracking-tighter text-white uppercase italic">Nexus Cortex</h2>
          <p className="mt-2 text-sm text-slate-400 font-medium">Autonomous Multi-Tenant Execution</p>
        </div>

        <form onSubmit={handleMagicLink} className="mt-8 space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Email Address</label>
            <input
              type="email"
              required
              className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all placeholder:text-slate-700"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          
          <button 
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {loading ? <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Mail className="w-4 h-4" />}
            Send Magic Link
          </button>
        </form>

        <div className="relative py-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/5"></div></div>
          <div className="relative flex justify-center text-[10px] font-black uppercase tracking-widest bg-slate-950 px-2 text-slate-500">OR CONTINUE WITH</div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button onClick={() => handleSocialLogin('google')} className="flex items-center justify-center gap-2 bg-slate-950 border border-white/5 hover:bg-slate-900 py-3 rounded-xl transition-colors">
            <Chrome className="w-4 h-4 text-white" />
            <span className="text-xs font-bold text-white uppercase">Google</span>
          </button>
          <button onClick={() => handleSocialLogin('github')} className="flex items-center justify-center gap-2 bg-slate-950 border border-white/5 hover:bg-slate-900 py-3 rounded-xl transition-colors">
            <Github className="w-4 h-4 text-white" />
            <span className="text-xs font-bold text-white uppercase">GitHub</span>
          </button>
        </div>

        {tenantNotFound && <div className="mt-4 p-4 bg-amber-500/20 border border-amber-500/50 rounded-xl text-xs text-amber-300 text-center font-bold">
          Your account setup is still processing. Try refreshing or logging out and back in.
          <button onClick={() => window.location.reload()} className="ml-2 underline hover:text-white transition-colors">Refresh</button>
        </div>}
        {paidPolling && <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-300 text-center font-bold flex items-center justify-center gap-2">
          <div className="w-4 h-4 border-2 border-emerald-500/20 border-t-emerald-400 rounded-full animate-spin" />
          Confirming your payment...
        </div>}
        {message && <div className="mt-4 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-xs text-indigo-300 text-center font-bold">{message}</div>}
      </div>
    </div>
  );
}
