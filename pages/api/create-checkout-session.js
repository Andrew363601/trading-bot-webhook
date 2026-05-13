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
    if (!priceId) return res.status(400).json({ error: 'Invalid tier selected' });

    try {
        // 1. Check if user already has a Stripe customer ID
        const { data: subData } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('tenant_id', tenantId)
            .single();

        let customerId = subData?.stripe_customer_id;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email,
                metadata: { tenantId }
            });
            customerId = customer.id;
        }

        // 2. Create Checkout Session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            subscription_data: {
                trial_period_days: 14,
                metadata: { tenantId }
            },
            success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/audit?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/demo-index#pricing`,
            metadata: { tenantId, tier }
        });

        res.status(200).json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('[STRIPE_CHECKOUT_ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
}
