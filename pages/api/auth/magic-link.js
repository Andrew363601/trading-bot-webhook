// pages/api/auth/magic-link.js
// Sends Supabase magic link with redirect params for webhook onboarding.
// When a user provides email + asset + strategy_name from the landing page
// chat widget, the magic link redirects them back with ?webhook_asset=...
// query params so the dashboard auto-creates their strategy on login.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, asset, strategy_name } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const redirectParams = new URLSearchParams();
    if (asset) redirectParams.set('webhook_asset', asset);
    if (strategy_name) redirectParams.set('webhook_strategy', strategy_name);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://nexustradingagent.com'}/?${redirectParams.toString()}`,
        shouldCreateUser: true
      }
    });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: 'Magic link sent. Check your email.'
    });
  } catch (e) {
    console.error('[MAGIC LINK] Send failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
