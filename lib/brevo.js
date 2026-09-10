// lib/brevo.js
// Shared Brevo contact sync helper.
// Extracted pattern from pages/api/stripe-webhook.js (kept local there to honor
// the "no changes to stripe-webhook.js" constraint) — this copy adds the
// 'challenge' action used by /api/challenge-join.
// All failures are swallowed (warn only) — Brevo must never break a user flow.

const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_TRIAL_LIST_ID = process.env.BREVO_TRIAL_LIST_ID;

export async function syncToBrevo(email, tier, action) {
  if (!BREVO_KEY || !email) return;

  try {
    if (action === 'subscribe') {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          listIds: BREVO_TRIAL_LIST_ID ? [parseInt(BREVO_TRIAL_LIST_ID)] : [],
          attributes: {
            TRIAL_TIER: tier,
            SIGNUP_SOURCE: 'stripe_checkout'
          }
        })
      });
    } else if (action === 'challenge') {
      // 100K Challenge entry — tag the contact at entry time.
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          listIds: BREVO_TRIAL_LIST_ID ? [parseInt(BREVO_TRIAL_LIST_ID)] : [],
          attributes: {
            TRIAL_TIER: '100K_CHALLENGE',
            SIGNUP_SOURCE: 'challenge_entry'
          }
        })
      });
    } else if (action === 'convert') {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          attributes: {
            PAID_TIER: tier,
            TRIAL_TIER: null,
            CONVERTED_AT: new Date().toISOString()
          }
        })
      });
    } else if (action === 'cancel') {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          attributes: { TRIAL_TIER: null, CANCELED_AT: new Date().toISOString() }
        })
      });
    }
  } catch (e) {
    console.warn('[BREVO_SYNC] Failed:', e.message);
  }
}
