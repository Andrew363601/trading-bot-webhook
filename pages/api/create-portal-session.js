import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { verifyTenantContext } from '../../lib/auth-middleware';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Authenticate tenant from Bearer token
        let tenantContext;
        try {
            tenantContext = await verifyTenantContext(req);
        } catch (authErr) {
            return res.status(401).json({ error: authErr.message });
        }

        const tenantId = tenantContext.tenantId;

        // Fetch stripe_customer_id from subscriptions table
        const { data: sub, error: subError } = await supabase
            .from('subscriptions')
            .select('stripe_customer_id')
            .eq('tenant_id', tenantId)
            .maybeSingle();

        if (subError) {
            console.error('[PORTAL_SESSION] DB error checking subscription:', subError);
            return res.status(500).json({ error: 'Database error fetching billing details.' });
        }

        const customerId = sub?.stripe_customer_id;
        if (!customerId) {
            return res.status(400).json({ error: 'No billing account found for this workspace.' });
        }

        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || req.headers.origin || 'http://localhost:3000';

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${siteUrl}/?billing=updated`
        });

        return res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('[PORTAL_SESSION] Stripe billing portal session creation error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create billing portal session.' });
    }
}
