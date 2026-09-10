// pages/api/challenge-join.js
// 100K Simulation Challenge — join endpoint (auth required).
// One entry per tenant. Requires an opted-in leaderboard profile.

import { withTenantAuth } from '../../lib/auth-middleware';

const CHALLENGE_START = '2026-09-11T00:00:00Z';
const CHALLENGE_DAYS = 30;

export default withTenantAuth(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = req.tenant.supabase;
  const tenantId = req.tenant.tenantId;

  try {
    // 1. Look up tenant's leaderboard profile; must be opted in.
    const { data: profile, error: profileErr } = await supabase
      .from('public_profiles')
      .select('alias, opt_in')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (profileErr) {
      console.error('[CHALLENGE_JOIN] Profile lookup error:', profileErr);
      return res.status(500).json({ error: 'Failed to verify leaderboard profile' });
    }

    if (!profile || !profile.opt_in) {
      return res.status(400).json({
        error: 'Join the leaderboard first (opt in with an alias), then enter the challenge.'
      });
    }

    // 2. Reject if an entry already exists (UNIQUE constraint on tenant_id).
    const { data: existing } = await supabase
      .from('challenge_entries')
      .select('id')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Already entered' });
    }

    // 3. Fixed window. If now < window_start, status='active' anyway (entry held, scoring starts Friday).
    const windowStart = new Date(CHALLENGE_START);
    const windowEnd = new Date(windowStart.getTime() + CHALLENGE_DAYS * 24 * 60 * 60 * 1000);

    // 4. Insert row.
    const { error: insertErr } = await supabase
      .from('challenge_entries')
      .insert({
        tenant_id: tenantId,
        alias: profile.alias,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        status: 'active'
      });

    if (insertErr) {
      // Race on UNIQUE constraint
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'Already entered' });
      }
      console.error('[CHALLENGE_JOIN] Insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to create challenge entry' });
    }

    // Grant paper-trading access for the full window (idempotent).
    // Do NOT downgrade anyone on a paid Stripe sub.
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const hasPaidSub = sub && ['active', 'trialing'].includes(String(sub.status).toLowerCase());

    if (!hasPaidSub) {
      await supabase
        .from('tenants')
        .update({ billing_tier: 'RETAIL', subscription_active: true })
        .eq('id', tenantId);
    }

    // 5. Return.
    return res.status(200).json({
      ok: true,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      alias: profile.alias
    });
  } catch (err) {
    console.error('[CHALLENGE_JOIN] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
