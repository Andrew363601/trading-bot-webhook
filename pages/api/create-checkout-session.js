import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { tier, email, tenantId, uiMode } = req.body;
    const isEmbedded = uiMode === 'embedded';

    // Identity guard: onboarding-fallback below must only fire for genuinely
    // fresh signups — never for undefined identity (prevents "undefined
    // Portfolio" tenants and slug collisions).
    if (!tenantId || !email) {
        return res.status(401).json({ error: 'Sign-in required before checkout.' });
    }

    // Define price IDs for your Stripe products (Sandbox IDs)
    const priceIds = {
        'RETAIL': process.env.STRIPE_PRICE_RETAIL,
        'PRO': process.env.STRIPE_PRICE_PRO,
        'INSTITUTIONAL': process.env.STRIPE_PRICE_INSTITUTIONAL
    };

    const priceId = priceIds[tier];
    if (!priceId) {
        return res.status(400).json({ error: `Environment variable for ${tier} price is missing or tier is invalid.` });
    }

    // Ensure we have a site URL (fallback to request origin for local dev)
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || req.headers.origin;

    try {
        // 1. Get the actual tenant_id from the auth_user_id (tenantId in body)
        const { data: userLink } = await supabase
            .from('tenant_users')
            .select('tenant_id')
            .eq('auth_user_id', tenantId)
            .maybeSingle();

        let realTenantId = userLink?.tenant_id;

        // 🧩 ONBOARDING FALLBACK: If the Supabase auth trigger hasn't
        // completed yet, create the tenant + tenant_users rows synchronously
        // so the Stripe checkout can proceed without crashing.
        if (!realTenantId) {
            const { data: newTenant } = await supabase
                .from('tenants')
                .insert({
                    name: `${email} Portfolio`,
                    slug: `nexus-${(tenantId || '').substring(0, 8)}`,
                    billing_tier: 'FREE_TRIAL',
                    subscription_active: true
                })
                .select('id')
                .single();

            if (!newTenant) {
                throw new Error('Failed to create tenant account. Please try again.');
            }

            const { error: linkError } = await supabase
                .from('tenant_users')
                .insert({
                    tenant_id: newTenant.id,
                    auth_user_id: tenantId,
                    email: email,
                    role: 'TRIAL'
                });

            if (linkError) {
                // Race: the trigger may have fired between our two queries.
                // Retry the lookup instead of failing.
                const { data: retryLink } = await supabase
                    .from('tenant_users')
                    .select('tenant_id')
                    .eq('auth_user_id', tenantId)
                    .maybeSingle();
                if (retryLink) {
                    realTenantId = retryLink.tenant_id;
                } else {
                    throw new Error('Account setup delayed. Please try again in 30 seconds.');
                }
            } else {
                realTenantId = newTenant.id;
            }
        }

        // 2. Check if user already has a Stripe customer ID
        const { data: subData } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('tenant_id', realTenantId)
            .single();

        let customerId = subData?.stripe_customer_id;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email,
                metadata: { tenantId: realTenantId }
            });
            customerId = customer.id;

            // 💾 PERSIST: Immediately save stripe_customer_id to subscriptions table
            await supabase.from('subscriptions').upsert({
                tenant_id: realTenantId,
                stripe_customer_id: customerId,
                updated_at: new Date().toISOString()
            }, { onConflict: 'tenant_id' });
        }

        // 3. 100K Challenge coupon guard: active challenge entry + buying PRO or RETAIL
        //    → 100% off first 30 days (coupon IS their free window, so no 7d trial).
        //    Entry may be 'pending_payment' (pre-checkout) or 'active'. No window_start
        //    bound — buyers may check out before the challenge start date.
        const isChallengeBuyer = ['PRO', 'RETAIL'].includes(tier) && await (async () => {
            const nowIso = new Date().toISOString();
            const { data: entry } = await supabase
                .from('challenge_entries')
                .select('id')
                .eq('tenant_id', realTenantId)
                .in('status', ['active', 'pending_payment'])
                .gte('window_end', nowIso)
                .maybeSingle();
            return !!entry;
        })();

        // 4. Create Checkout Session
        //    Embedded mode (challenge popup): dashboard-driven payment methods
        //    (Apple/Google Pay/Link + card), no redirects, clientSecret returned.
        //    Hosted mode: byte-identical to previous behavior.
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            ...(isEmbedded ? {} : { payment_method_types: ['card'] }),
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            ...(isChallengeBuyer
                ? {
                    discounts: [{ promotion_code: process.env.CHALLENGE_PROMO_CODE }],
                    subscription_data: {
                        trial_period_days: 0,
                        metadata: { tenantId: realTenantId, tier }
                    }
                }
                : {
                    subscription_data: {
                        trial_period_days: 7,
                        metadata: { tenantId: realTenantId, tier }
                    }
                }),
            ...(isEmbedded
                ? {
                    ui_mode: 'embedded',
                    redirect_on_completion: 'never'
                }
                : {
                    success_url: `${siteUrl}/auth?paid=true`,
                    cancel_url: `${siteUrl}/plans`
                }),
            metadata: { tenantId: realTenantId, tier }
        });

        if (isEmbedded) {
            return res.status(200).json({ sessionId: session.id, clientSecret: session.client_secret });
        }
        res.status(200).json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('[STRIPE_CHECKOUT_ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
}
