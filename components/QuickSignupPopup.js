import { useState } from 'react';
import { trackEvent } from '../lib/analytics';

const PLAN_LABELS = {
  RETAIL: 'Retail',
  PRO: 'Pro',
  INSTITUTIONAL: 'Institutional',
};

export default function QuickSignupPopup({ plan, onClose }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const planLabel = PLAN_LABELS[plan] || plan;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);

    try {
      // 1. Brevo: add to trial list with source tracking
      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          type: 'trial',
          source: 'pricing_card',
          strategy_name: plan,
        }),
      }).catch(() => {});

      // 2. GA4: trial_signup with plan source
      trackEvent('trial_signup', { method: 'pricing_card', plan });

      // 3. Send magic link with plan in redirect URL
      await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, plan }),
      });

      setSent(true);
    } catch (err) {
      setSent(true);
    }
    setLoading(false);
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.6)', zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', padding: '30px', borderRadius: '12px',
          maxWidth: '400px', width: '90%', position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '10px', right: '15px',
            background: 'none', border: 'none', fontSize: '22px',
            cursor: 'pointer', color: '#999',
          }}
        >
          x
        </button>

        {!sent ? (
          <>
            <h2 style={{ margin: '0 0 5px', fontSize: '22px', color: '#1a1a2e' }}>
              Start Your {planLabel} 7-Day Trial
            </h2>
            <p style={{ color: '#666', fontSize: '14px', margin: '10px 0 20px' }}>
              Get full access to Nexus Quantitative — no credit card required.
            </p>
            <form onSubmit={handleSubmit}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
                style={{
                  width: '100%', padding: '12px', border: '1px solid #ddd',
                  borderRadius: '6px', margin: '0 0 15px', fontSize: '15px',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%', padding: '13px', background: '#1a1a2e',
                  color: '#fff', border: 'none', borderRadius: '6px',
                  fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'wait' : 'pointer',
                }}
              >
                {loading ? 'Sending...' : '🚀 Activate Free Trial'}
              </button>
            </form>
            <p style={{ color: '#999', fontSize: '11px', marginTop: '15px', textAlign: 'center' }}>
              Nexus Quantitative
            </p>
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: '10px' }}>✅</div>
              <h2 style={{ margin: '0 0 5px', fontSize: '22px', color: '#1a1a2e' }}>
                Magic Link Sent!
              </h2>
              <p style={{ color: '#666', fontSize: '14px', margin: '15px 0' }}>
                We sent a login link to<br />
                <strong style={{ color: '#1a1a2e' }}>{email}</strong>
              </p>
              <p style={{ color: '#888', fontSize: '12px' }}>
                Click the link in your email to activate your {planLabel} trial and access the dashboard.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}