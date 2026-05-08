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
  const router = useRouter();
  const supabase = useSupabaseClient();
  const session = useSession();

  useEffect(() => {
    // Wait for Supabase to process OAuth callback
    const checkSession = async () => {
      try {
        const { data: { session: activeSession } } = await supabase.auth.getSession();
        
        if (activeSession) {
          // Session exists, redirect to dashboard
          router.replace('/index');
        } else {
          // No session after callback processing
          setSessionCheckComplete(true);
        }
      } catch (err) {
        console.error('Session check error:', err);
        setSessionCheckComplete(true);
      }
    };

    checkSession();
  }, [supabase, router]);

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

        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => handleSocialLogin('google')} className="flex items-center justify-center gap-2 bg-slate-950 border border-white/5 hover:bg-slate-900 py-3 rounded-xl transition-colors">
            <Chrome className="w-4 h-4 text-white" />
            <span className="text-xs font-bold text-white uppercase">Google</span>
          </button>
          <button onClick={() => handleSocialLogin('github')} className="flex items-center justify-center gap-2 bg-slate-950 border border-white/5 hover:bg-slate-900 py-3 rounded-xl transition-colors">
            <Github className="w-4 h-4 text-white" />
            <span className="text-xs font-bold text-white uppercase">GitHub</span>
          </button>
        </div>

        {message && <div className="mt-4 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-xs text-indigo-300 text-center font-bold">{message}</div>}
      </div>
    </div>
  );
}
