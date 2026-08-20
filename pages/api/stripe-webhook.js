import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sendGA4ServerEvent(eventName, params = {}) {
  const measurementId = 'G-7REMMP1S7R';
  const apiSecret = process.env.GA4_MEASUREMENT_PROTOCOL_SECRET || process.env.GA4_API_SECRET;

  if (!apiSecret) return;

  const { client_id, ...eventParams } = params;

  try {
    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${encodeURIComponent(apiSecret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: client_id || 'stripe-webhook',
        events: [{ name: eventName, params: eventParams }]
      })
    });
  } catch (error) {
    console.error(`[GA4] ${eventName} failed:`, error);
  }
}

// Brevo constants
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_TRIAL_LIST_ID = process.env.BREVO_TRIAL_LIST_ID;

// Helper to get raw body without 'micro'
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

// Brevo: sync contact + trial list based on subscription lifecycle
async function syncToBrevo(email, tier, action) {
  if (!BREVO_KEY || !email) return;

  try {
    if (action === 'subscribe') {
      // Create contact + add trial-{tier} attribute, add to trial list
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
    } else if (action === 'convert') {
      // Trial → Paid: update Brevo attributes
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          attributes: {
            PAID_TIER: tier,
            TRIAL_TIER: null,  // clear trial tier once converted to paid
            CONVERTED_AT: new Date().toISOString()
          }
        })
      });
    } else if (action === 'cancel') {
      // Canceled: clear trial tier attribute
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
        case 'checkout.session.completed': {
            // 🛠️ FIX: Session object has different fields than Subscription object.
            // session.status = "complete" (not "active"/"trialing").
            // session.id = "cs_xxx" (not "sub_xxx").
            // Fetch the actual subscription from Stripe to get the real status.
            const session = event.data.object;
            const csTenantId = session.metadata?.tenantId;
            const csTier = session.metadata?.tier || 'RETAIL';

            if (csTenantId && session.subscription) {
                let realSub;
                try {
                    realSub = await stripe.subscriptions.retrieve(session.subscription);
                } catch (e) {
                    console.error(`[WEBHOOK] Failed to retrieve subscription ${session.subscription}: ${e.message}`);
                }

                if (realSub) {
                    const isBillingActive = realSub.status === 'active' || realSub.status === 'trialing';

                    await supabase.from('subscriptions').upsert({
                        tenant_id: csTenantId,
                        stripe_customer_id: session.customer,
                        stripe_subscription_id: realSub.id,
                        status: realSub.status,
                        tier: csTier,
                        current_period_end: realSub.current_period_end ? new Date(realSub.current_period_end * 1000).toISOString() : null,
                        cancel_at_period_end: realSub.cancel_at_period_end,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'tenant_id' });

                    const TIER_LIMITS = { FREE_TRIAL: 1, RETAIL: 3, PRO: 10, INSTITUTIONAL: 20, ADMIN: 9999 };
                    const tierLimit = TIER_LIMITS[(csTier || '').toUpperCase()] ?? TIER_LIMITS.FREE_TRIAL;

                    await supabase.from('tenants').update({
                        billing_tier: csTier,
                        subscription_active: isBillingActive,
                        max_concurrent_strategies: tierLimit,
                        updated_at: new Date().toISOString()
                    }).eq('id', csTenantId);
                }
            }

            // Sync to Brevo & GA4 conversion tracking
            const checkoutEmail = session.customer_details?.email || session.customer_email;
            if (checkoutEmail) {
                await syncToBrevo(checkoutEmail, csTier, 'subscribe');
            }

            await sendGA4ServerEvent('paid_conversion', {
                client_id: session.customer_details?.email || session.customer_email || session.id || 'stripe-webhook',
                tier: (csTier || 'RETAIL').toUpperCase(),
                value: typeof session.amount_total === 'number' ? session.amount_total / 100 : 0,
                currency: (session.currency || 'usd').toUpperCase(),
                method: 'stripe_checkout'
            });
            break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            const sub = event.data.object;
            const tenantId = sub.metadata?.tenantId;
            const tier = sub.metadata?.tier || 'RETAIL';

            if (tenantId) {
                await supabase.from('subscriptions').upsert({
                    tenant_id: tenantId,
                    stripe_customer_id: sub.customer,
                    stripe_subscription_id: sub.id,
                    status: sub.status,
                    tier: tier,
                    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
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

            // Sync to Brevo & GA4: trial → paid conversion (subscription activation)
            if (event.type === 'customer.subscription.updated' && sub.status === 'active') {
                const tenantEmail = await getTenantEmail(tenantId);
                const tenantTier = await getTenantTier(tenantId);
                if (tenantEmail) {
                    await syncToBrevo(tenantEmail, tenantTier, 'convert');
                }

                await sendGA4ServerEvent('paid_conversion', {
                    client_id: tenantEmail || sub.customer || sub.id || 'stripe-webhook',
                    tier: (tenantTier || tier || 'RETAIL').toUpperCase(),
                    value: typeof sub.items?.data?.[0]?.plan?.amount === 'number' ? sub.items.data[0].plan.amount / 100 : 0,
                    currency: (sub.currency || 'usd').toUpperCase(),
                    method: 'stripe_subscription'
                });
            }
            break;
        }

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
                  await syncToBrevo(deletedEmail, deletedTier, 'cancel');
                }
            }
            break;
    }

    res.json({ received: true });
}
