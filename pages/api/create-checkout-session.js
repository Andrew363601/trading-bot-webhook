import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { tier, email, tenantId } = req.body;

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

        // 3. Create Checkout Session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            subscription_data: {
                trial_period_days: 7,
                metadata: { tenantId: realTenantId }
            },
            payment_method_collection: 'if_required',
            success_url: `${siteUrl}/auth?paid=true`,
            cancel_url: `${siteUrl}/plans`,
            metadata: { tenantId: realTenantId, tier }
        });

        res.status(200).json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('[STRIPE_CHECKOUT_ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
}
