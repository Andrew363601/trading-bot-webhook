import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mailchimp constants
const MC_DC = 'us1';
const MC_LIST = process.env.MAILCHIMP_AUDIENCE_ID || 'd8196c5e75';
const MC_KEY = process.env.MAILCHIMP_API_KEY;

// Helper to get raw body without 'micro'
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

// Mailchimp: sync contact tags based on subscription lifecycle
async function syncToMailchimp(email, tier, action) {
  if (!MC_KEY || !email) return;
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const auth = Buffer.from('anystring:' + MC_KEY).toString('base64');
  const base = `https://${MC_DC}.api.mailchimp.com/3.0/lists/${MC_LIST}/members/${hash}`;

  if (action === 'subscribe') {
    // Create contact + add trial-{tier} tag
    await fetch(base, {
      method: 'PUT',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email_address: email,
        status_if_new: 'subscribed',
        status: 'subscribed',
        merge_fields: { FNAME: '', ADDRESS: { addr1: '', city: '', state: '', zip: '', country: 'US' } }
      })
    });
    await fetch(`${base}/tags`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ name: `trial-${tier}`, status: 'active' }] })
    });
  } else if (action === 'convert') {
    // Trial → Paid: remove trial tag, add paid tag
    await fetch(`${base}/tags`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: [
          { name: `trial-${tier}`, status: 'inactive' },
          { name: `paid-${tier}`, status: 'active' }
        ]
      })
    });
  } else if (action === 'cancel') {
    // Canceled: remove trial tag
    await fetch(`${base}/tags`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ name: `trial-${tier}`, status: 'inactive' }] })
    });
  }
}

// Look up tenant email from tenant_users table
async function getTenantEmail(tenantId) {
  if (!tenantId) return '';
  try {
    const { data } = await supabase
      .from('tenant_users')
      .select('email')
      .eq('tenant_id', tenantId)
      .limit(1)
      .single();
    return data?.email || '';
  } catch {
    return '';
  }
}

// Look up tenant tier from subscriptions table
async function getTenantTier(tenantId) {
  if (!tenantId) return 'RETAIL';
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('tenant_id', tenantId)
      .single();
    return data?.tier || 'RETAIL';
  } catch {
    return 'RETAIL';
  }
}

export const config = {
    api: { bodyParser: false }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    let buf;
    try {
        buf = await getRawBody(req);
    } catch (e) {
        return res.status(400).send(`Raw body error: ${e.message}`);
    }
    
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    } catch (err) {
        console.error(`[STRIPE_WEBHOOK_ERROR]: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const session = event.data.object;

    switch (event.type) {
        case 'checkout.session.completed':
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
            const sub = event.data.object;
            const tenantId = sub.metadata.tenantId || session.metadata?.tenantId;
            const tier = sub.metadata.tier || session.metadata?.tier || 'RETAIL';

            if (tenantId) {
                await supabase.from('subscriptions').upsert({
                    tenant_id: tenantId,
                    stripe_customer_id: sub.customer,
                    stripe_subscription_id: sub.id || sub.subscription,
                    status: sub.status,
                    tier: tier,
                    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                    cancel_at_period_end: sub.cancel_at_period_end,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'tenant_id' });

                const isBillingActive = sub.status === 'active' || sub.status === 'trialing';

                // Keep the per-tier active-strategy quota in sync with the user's plan.
                // Single source of truth — see TIER_CONCURRENT_LIMITS in lib/tenant-context.js.
                const TIER_LIMITS = { FREE_TRIAL: 1, RETAIL: 3, PRO: 10, INSTITUTIONAL: 20, ADMIN: 9999 };
                const tierLimit = TIER_LIMITS[(tier || '').toUpperCase()] ?? TIER_LIMITS.FREE_TRIAL;

                await supabase.from('tenants').update({
                    billing_tier: tier,
                    subscription_active: isBillingActive,
                    max_concurrent_strategies: tierLimit,
                    updated_at: new Date().toISOString() // Track timestamp for grace period
                }).eq('id', tenantId);

                // 🔒 If a subscription transitions into a non-active state (past_due, unpaid,
                // canceled, incomplete_expired), force ALL active strategies OFF immediately.
                // This protects the account from continuing to trade without valid billing.
                // 🛠️ Exception: respect admin manual overrides on PAID/ADMIN tiers — we just
                // wrote the new tier, so re-read and skip the lockdown for those.
                if (!isBillingActive) {
                    const PAID_TIERS = ['RETAIL', 'PRO', 'INSTITUTIONAL', 'ADMIN'];
                    const { data: tenantAfter } = await supabase
                        .from('tenants')
                        .select('subscription_active, billing_tier')
                        .eq('id', tenantId)
                        .single();
                    const manualOverride = tenantAfter?.subscription_active === true
                        && PAID_TIERS.includes((tenantAfter?.billing_tier || '').toUpperCase());
                    if (!manualOverride) {
                        await supabase.from('strategy_config')
                            .update({ is_active: false, updated_at: new Date().toISOString() })
                            .eq('tenant_id', tenantId)
                            .eq('is_active', true);
                        console.warn(`[STRIPE_WEBHOOK] Deactivated strategies for ${tenantId} (status=${sub.status}).`);
                    } else {
                        console.log(`[STRIPE_WEBHOOK] Skipping lockdown for ${tenantId} due to manual override (tier=${tenantAfter.billing_tier}).`);
                    }
                }
            }

            // Mailchimp: create contact + trial-{tier} tag (checkout only)
            if (event.type === 'checkout.session.completed') {
              const checkoutEmail = session.customer_details?.email || session.customer_email;
              if (checkoutEmail) {
                await syncToMailchimp(checkoutEmail, tier, 'subscribe');
              }
            }

            // Mailchimp: trial → paid conversion (subscription activation)
            if (event.type === 'customer.subscription.updated' && sub.status === 'active') {
              const tenantEmail = await getTenantEmail(tenantId);
              const tenantTier = await getTenantTier(tenantId);
              if (tenantEmail) {
                await syncToMailchimp(tenantEmail, tenantTier, 'convert');
              }
            }
            break;

        case 'customer.subscription.deleted':
            const deletedSub = event.data.object;
            const deletedTenantId = deletedSub.metadata.tenantId;

            if (deletedTenantId) {
                await supabase.from('subscriptions').update({
                    status: 'canceled',
                    updated_at: new Date().toISOString()
                }).eq('tenant_id', deletedTenantId);

                await supabase.from('tenants').update({
                    subscription_active: false,
                    updated_at: new Date().toISOString() // Start grace period timer
                }).eq('id', deletedTenantId);

                // 🔒 Force-disable all active strategies on cancellation so no further
                // LIVE or PAPER execution occurs once the subscription is gone.
                await supabase.from('strategy_config')
                    .update({ is_active: false, updated_at: new Date().toISOString() })
                    .eq('tenant_id', deletedTenantId)
                    .eq('is_active', true);
                console.warn(`[STRIPE_WEBHOOK] Subscription deleted — deactivated strategies for ${deletedTenantId}.`);

                // Mailchimp: remove trial tag
                const deletedEmail = await getTenantEmail(deletedTenantId);
                const deletedTier = await getTenantTier(deletedTenantId);
                if (deletedEmail) {
                  await syncToMailchimp(deletedEmail, deletedTier, 'cancel');
                }
            }
            break;
    }

    res.json({ received: true });
}
