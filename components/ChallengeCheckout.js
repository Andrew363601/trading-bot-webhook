// components/ChallengeCheckout.js
// 100K Challenge — 3-step embedded checkout popup (no page redirect).
// Step 0: auth gate (magic link / OAuth inside the popup) → Step 1: opt-in
// (creates pending_payment entry) → Step 2: embedded Stripe checkout
// (Apple/Google Pay/Link per dashboard settings + card) → Step 3: confirmation.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { loadStripe } from '@stripe/stripe-js';
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout
} from '@stripe/react-stripe-js';
import { useSupabaseClient } from '@supabase/auth-helpers-react';
import { fetchSiteContent, FALLBACK_CONTENT } from '../lib/site-content';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

// Display name → API tier (Institutional is not a challenge tier).
const TIER_MAP = { Retail: 'RETAIL', Pro: 'PRO' };

// Hardcoded 028 fallback — same source of truth as lib/site-content.js.
const FALLBACK_PRICING = FALLBACK_CONTENT.pricing.filter((t) => TIER_MAP[t.name]);

const CHALLENGE_RESUME_KEY = 'challenge_checkout_resume';

export default function ChallengeCheckout({ onClose, onEntered }) {
  const supabase = useSupabaseClient();
  const [step, setStep] = useState(0); // 0 auth gate, 1 opt-in, 2 checkout, 3 confirmation
  const [tier, setTier] = useState('RETAIL');
  const [clientSecret, setClientSecret] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState(FALLBACK_PRICING);
  const [email, setEmail] = useState('');
  const [authMessage, setAuthMessage] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [discordState, setDiscordState] = useState('pending'); // pending | linked | failed
  const [discordError, setDiscordError] = useState(null);

  // Temporary mount diagnostics (Push I — popup-mount hardening rider).
  useEffect(() => {
    console.log('[ChallengeCheckout] mounted, step=', step);
  }, [step]);

  // ── Pricing parity: same source as demo-index (site_content → 028 fallback) ──
  useEffect(() => {
    let isCancelled = false;
    fetchSiteContent(supabase).then((content) => {
      if (isCancelled) return;
      const tiers = (content.pricing || FALLBACK_CONTENT.pricing)
        .filter((t) => TIER_MAP[t.name]);
      if (tiers.length) setPricing(tiers);
    }).catch((e) => {
      console.error('[ChallengeCheckout] pricing fetch failed:', e);
      setError('Could not load pricing. Please try again.');
    });
    return () => { isCancelled = true; };
  }, [supabase]);

  // ── Auth gate: session exists → step 1; else step 0 ──
  useEffect(() => {
    let isCancelled = false;
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (!isCancelled && session) setStep(1);
      })
      .catch((e) => {
        console.error('[ChallengeCheckout] getSession failed:', e);
        if (!isCancelled) setError('Could not check your session. Please try again.');
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_IN' && session) setStep(1);
      }
    );
    return () => {
      isCancelled = true;
      subscription?.unsubscribe();
    };
  }, [supabase]);

  // ── Step 3: Discord auto-join (Discord sign-ins only, once) ──
  useEffect(() => {
    if (step !== 3 || discordState !== 'pending') return;
    let isCancelled = false;

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const isDiscord =
          session?.user?.user_metadata?.provider === 'discord' &&
          !!session?.provider_token;

        if (!isDiscord) {
          // Email/Google users join manually via the invite button.
          if (!isCancelled) setDiscordState('manual');
          return;
        }

        const res = await fetch('/api/discord-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`
          },
          body: JSON.stringify({ providerToken: session.provider_token })
        });
        const json = await res.json().catch(() => ({}));
        if (isCancelled) return;

        if (res.ok && json.ok) {
          setDiscordState('linked');
        } else {
          setDiscordError(json.error || 'Discord auto-join failed.');
          setDiscordState('failed');
        }
      } catch (e) {
        console.error('[ChallengeCheckout] discord-link failed:', e);
        if (!isCancelled) {
          setDiscordError('Discord auto-join failed.');
          setDiscordState('failed');
        }
      }
    })();

    return () => { isCancelled = true; };
  }, [step, discordState, supabase]);

  // ── Step 0 actions ──
  const handleMagicLink = async (e) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthMessage(null);
    setError(null);
    try {
      sessionStorage.setItem(CHALLENGE_RESUME_KEY, '1');
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}/leaderboard` }
      });
      if (otpError) {
        setError(otpError.message);
        sessionStorage.removeItem(CHALLENGE_RESUME_KEY);
      } else {
        setAuthMessage('Check your email for the magic login link!');
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleOAuth = async (provider) => {
    setAuthBusy(true);
    setError(null);
    try {
      sessionStorage.setItem(CHALLENGE_RESUME_KEY, '1');
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${location.origin}/leaderboard` }
      });
      if (oauthError) {
        setError(oauthError.message);
        sessionStorage.removeItem(CHALLENGE_RESUME_KEY);
      }
    } finally {
      // OAuth success redirects away; failure must not freeze the buttons.
      setAuthBusy(false);
    }
  };

  // ── Step 1 → create pending entry, then create embedded checkout session. ──
  const handleContinue = async (selectedTier) => {
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setStep(0);
        setBusy(false);
        return;
      }
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`
      };

      const joinRes = await fetch('/api/challenge-join', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ intent: 'pending' })
      });
      const joinJson = await joinRes.json();
      if (!joinRes.ok) {
        setError(joinJson.error || 'Could not start the challenge entry.');
        setBusy(false);
        return;
      }

      const csRes = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ tenantId: session.user.id, email: session.user.email, tier: selectedTier, uiMode: 'embedded' })
      });
      const csJson = await csRes.json();
      if (!csRes.ok || !csJson.clientSecret) {
        setError(csJson.error || 'Could not start checkout. Please try again.');
        setBusy(false);
        return;
      }

      setTier(selectedTier);
      setClientSecret(csJson.clientSecret);
      setStep(2);
    } catch (e) {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = () => {
    setStep(3);
    if (onEntered) onEntered();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b0e14] p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-400 hover:text-white"
          aria-label="Close"
        >
          ✕
        </button>

        {step === 0 && (
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight text-white">
              Sign in to enter
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              The 100K Challenge requires an account — first 30 days free.
            </p>

            {authMessage ? (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
                {authMessage}
              </div>
            ) : (
              <>
                <form onSubmit={handleMagicLink} className="mt-4 space-y-3">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-500/50 placeholder:text-gray-600"
                  />
                  <button
                    type="submit"
                    disabled={authBusy}
                    className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {authBusy ? 'Sending…' : 'Continue with email'}
                  </button>
                </form>

                <div className="my-4 flex items-center gap-3 text-xs text-gray-500">
                  <span className="h-px flex-1 bg-white/10" />
                  or
                  <span className="h-px flex-1 bg-white/10" />
                </div>

                <div className="space-y-3">
                  <button
                    onClick={() => handleOAuth('google')}
                    disabled={authBusy}
                    className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-50"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.07-4.74 3.07-8.1z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.16a6.6 6.6 0 0 1 0-4.32V7H2.18a11 11 0 0 0 0 10l3.66-2.84z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                  </button>
                  <button
                    onClick={() => handleOAuth('discord')}
                    disabled={authBusy}
                    className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#5865F2] px-4 py-3 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.8 13.8 0 0 0-.64 1.28 18.3 18.3 0 0 0-5.5 0 13.8 13.8 0 0 0-.64-1.28c-1.71.29-3.37.8-4.93 1.51A20.3 20.3 0 0 0 .1 18.06a19.9 19.9 0 0 0 6.07 3.03c.49-.66.93-1.37 1.3-2.1a12.9 12.9 0 0 1-2.05-.98c.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.16 0c.16.13.33.26.5.38-.65.39-1.34.71-2.05.98.37.73.81 1.44 1.3 2.1a19.8 19.8 0 0 0 6.07-3.03 20.3 20.3 0 0 0-3.58-13.69zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42c1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42zm7.96 0c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42c1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42z" />
                    </svg>
                    Continue with Discord
                  </button>
                </div>
              </>
            )}

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight text-white">
              Enter the 100K Challenge
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              First 30 days FREE with challenge entry — $0.00 due today.
            </p>

            <div className="mt-4 space-y-3">
              {pricing.map((plan) => {
                const apiTier = TIER_MAP[plan.name];
                const isPopular = !!plan.popular;
                return (
                  <button
                    key={plan.name}
                    onClick={() => handleContinue(apiTier)}
                    disabled={busy}
                    className={`relative w-full rounded-xl border p-4 text-left transition disabled:opacity-50 ${
                      isPopular
                        ? 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    {isPopular && (
                      <span className="absolute -top-2.5 right-4 rounded-full bg-emerald-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-slate-950">
                        POPULAR
                      </span>
                    )}
                    <div className="flex items-baseline justify-between">
                      <div className="font-bold text-white">{plan.name}</div>
                      <div className="text-sm font-bold text-white">
                        {plan.price}
                        <span className="text-xs font-normal text-gray-400">/mo</span>
                      </div>
                    </div>
                    <ul className="mt-2 space-y-1 text-xs text-gray-300">
                      {(plan.features || []).map((f) => (
                        <li key={f}>✓ {f}</li>
                      ))}
                    </ul>
                    <div className={`mt-2 text-xs ${isPopular ? 'text-emerald-400' : 'text-gray-400'}`}>
                      First 30 days FREE with challenge entry — $0.00 due today
                    </div>
                    <div className="mt-1 text-[10px] text-gray-500">
                      Card required — $0 charged today
                    </div>
                  </button>
                );
              })}
            </div>

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </div>
        )}

        {step === 2 && clientSecret && (
          <div>
            <h2 className="text-lg font-black uppercase tracking-tight text-white">
              Complete checkout
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              $0.00 due today — 30 days free, then {tier === 'PRO' ? '$149' : '$49'}/mo.
            </p>
            <div className="mt-4" id="challenge-checkout">
              <EmbeddedCheckoutProvider
                stripe={stripePromise}
                options={{ clientSecret, onComplete: handleComplete }}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </div>
        )}

        {step === 3 && (
          <div className="text-center">
            <div className="text-4xl">🏆</div>
            <h2 className="mt-2 text-xl font-black uppercase tracking-tight text-white">
              You&apos;re in — 30 days free
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              Your {tier} challenge window is active. $0.00 was due today.
            </p>
            <div className="mt-6 flex flex-col gap-3">
              {discordState === 'linked' ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-300">
                  ✓ You&apos;re in the Discord server — tagged as Challenger
                </div>
              ) : (
                <>
                  <button
                    className="rounded-xl bg-[#5865F2] px-4 py-3 font-bold text-white transition hover:opacity-90"
                    onClick={() =>
                      window.open(process.env.NEXT_PUBLIC_DISCORD_INVITE_URL, '_blank')
                    }
                  >
                    Join Discord
                  </button>
                  {discordError && (
                    <p className="text-xs text-red-400">{discordError}</p>
                  )}
                </>
              )}
              <Link
                href="/#dashboard"
                className="rounded-xl border border-white/15 px-4 py-3 font-bold text-white transition hover:bg-white/10"
                onClick={onClose}
              >
                Deploy your first strategy
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}