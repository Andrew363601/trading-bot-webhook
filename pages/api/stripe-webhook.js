import Stripe from 'stripe';
import { buffer } from 'micro';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
    api: { bodyParser: false }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const buf = await buffer(req);
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

                await supabase.from('tenants').update({
                    billing_tier: tier,
                    subscription_active: sub.status === 'active' || sub.status === 'trialing'
                }).eq('id', tenantId);
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
                    subscription_active: false
                }).eq('id', deletedTenantId);
            }
            break;
    }

    res.json({ received: true });
}
