// components/ChallengeCheckout.js
// 100K Challenge — 3-step embedded checkout popup (no page redirect).
// Step 1: opt-in (creates pending_payment entry) → Step 2: embedded Stripe checkout
// (Apple/Google Pay/Link per dashboard settings + card) → Step 3: confirmation.

import { useState } from 'react';
import Link from 'next/link';
import { loadStripe } from '@stripe/stripe-js';
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout
} from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

const RETAIL_FEATURES = [
  'Paper trading engine — simulate $100K without risk',
  'Up to 3 concurrent strategies',
  'Full analytics & trade journaling',
  'Leaderboard entry for the 100K Challenge'
];

const PRO_FEATURES = [
  'Live execution on Coinbase',
  'Up to 10 concurrent strategies',
  'Advanced analytics & priority support',
  'Leaderboard entry for the 100K Challenge'
];

export default function ChallengeCheckout({ onClose, onEntered }) {
  const [step, setStep] = useState(1); // 1 opt-in, 2 checkout, 3 confirmation
  const [tier, setTier] = useState('RETAIL');
  const [clientSecret, setClientSecret] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Step 1 → create pending entry, then create embedded checkout session.
  const handleContinue = async (selectedTier) => {
    setBusy(true);
    setError(null);
    try {
      const joinRes = await fetch('/api/challenge-join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: selectedTier, uiMode: 'embedded' })
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

  if (!step) return null;

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

        {step === 1 && (
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight text-white">
              Enter the 100K Challenge
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              30 days free — card required, $0.00 due today.
            </p>

            <div className="mt-4 space-y-3">
              <button
                onClick={() => handleContinue('RETAIL')}
                disabled={busy}
                className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-left transition hover:bg-emerald-500/20 disabled:opacity-50"
              >
                <div className="font-bold text-white">RETAIL — paper trading</div>
                <ul className="mt-2 space-y-1 text-xs text-gray-300">
                  {RETAIL_FEATURES.map((f) => (
                    <li key={f}>✓ {f}</li>
                  ))}
                </ul>
                <div className="mt-2 text-xs text-emerald-400">
                  30 days free, then $X/mo — card required at checkout
                </div>
              </button>

              <button
                onClick={() => handleContinue('PRO')}
                disabled={busy}
                className="w-full rounded-xl border border-white/10 bg-white/5 p-4 text-left transition hover:bg-white/10 disabled:opacity-50"
              >
                <div className="font-bold text-white">PRO — live execution</div>
                <ul className="mt-2 space-y-1 text-xs text-gray-300">
                  {PRO_FEATURES.map((f) => (
                    <li key={f}>✓ {f}</li>
                  ))}
                </ul>
                <div className="mt-2 text-xs text-gray-400">
                  First 30 days free with challenge entry
                </div>
              </button>
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
              $0.00 due today — 30 days free, then $X/mo.
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
              <button
                className="rounded-xl bg-[#5865F2] px-4 py-3 font-bold text-white transition hover:opacity-90"
                onClick={() => window.open('https://discord.gg/your-invite', '_blank')}
              >
                Join Discord
              </button>
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