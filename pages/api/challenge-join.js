// pages/api/challenge-join.js
// 100K Simulation Challenge — join endpoint (auth required).
// One entry per tenant. Leaderboard profile optional — alias auto-generated if absent.
// intent='pending' (default): pre-checkout entry, status='pending_payment' (no grants).
// intent='active': API/free path — immediate entry + RETAIL grant if no paid sub.

import { withTenantAuth } from '../../lib/auth-middleware';
import { syncToBrevo } from '../../lib/brevo';

const CHALLENGE_START = '2026-09-11T00:00:00Z';
const CHALLENGE_DAYS = 30;

function sanitizeAlias(email) {
  const local = String(email || '').split('@')[0];
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (cleaned || 'trader').slice(0, 16);
}

export default withTenantAuth(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = req.tenant.supabase;
  const tenantId = req.tenant.tenantId;
  const intent = req.body?.intent === 'active' ? 'active' : 'pending';
  const status = intent === 'active' ? 'active' : 'pending_payment';

  try {
    // 1. Leaderboard profile is optional now. If present and opted in, reuse its alias;
    //    otherwise auto-generate from the email local-part. The entry itself IS the
    //    leaderboard opt-in for the challenge cohort (alias-only output — privacy unchanged).
    let alias = null;

    const { data: profile, error: profileErr } = await supabase
      .from('public_profiles')
      .select('alias, opt_in')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (profileErr) {
      console.error('[CHALLENGE_JOIN] Profile lookup error:', profileErr);
      return res.status(500).json({ error: 'Failed to verify leaderboard profile' });
    }

    if (profile && profile.opt_in && profile.alias) {
      alias = profile.alias;
    } else {
      alias = sanitizeAlias(req.tenant.email);
    }

    // 2. Entry uniqueness (UNIQUE constraint on tenant_id) + resume logic:
    //    - pending_payment → return ok so the user can resume at checkout step 2
    //    - active          → 409 Already entered
    const { data: existing } = await supabase
      .from('challenge_entries')
      .select('id, status, window_start, window_end, alias')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'pending_payment') {
        return res.status(200).json({
          ok: true,
          resumed: true,
          status: existing.status,
          window_start: existing.window_start,
          window_end: existing.window_end,
          alias: existing.alias
        });
      }
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
        alias,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        status
      });

    if (insertErr) {
      // Race on UNIQUE constraint — re-read and apply resume logic.
      if (insertErr.code === '23505') {
        const { data: raced } = await supabase
          .from('challenge_entries')
          .select('status, window_start, window_end, alias')
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (raced && raced.status === 'pending_payment') {
          return res.status(200).json({
            ok: true,
            resumed: true,
            status: raced.status,
            window_start: raced.window_start,
            window_end: raced.window_end,
            alias: raced.alias
          });
        }
        return res.status(409).json({ error: 'Already entered' });
      }
      console.error('[CHALLENGE_JOIN] Insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to create challenge entry' });
    }

    // 5. Grant paper-trading access ONLY for the immediate ('active') path.
    //    pending_payment users get the grant from the webhook on checkout completion.
    //    Do NOT downgrade anyone on a paid Stripe sub.
    if (intent === 'active') {
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
    }

    // 5.5 Brevo tag at entry time. Fire-and-forget — Brevo failure must NOT fail the join.
    //     tenant email lives in tenant_users (not on req.tenant) — look it up service-role.
    (async () => {
      try {
        const { data: tu } = await supabase
          .from('tenant_users')
          .select('email')
          .eq('tenant_id', tenantId)
          .limit(1)
          .maybeSingle();
        if (tu?.email) {
          await syncToBrevo(tu.email, tier, 'challenge');
        }
      } catch (e) {
        console.warn('[CHALLENGE_JOIN] Brevo tag failed:', e?.message);
      }
    })();

    // 6. Return.
    return res.status(200).json({
      ok: true,
      status,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      alias
    });
  } catch (err) {
    console.error('[CHALLENGE_JOIN] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
