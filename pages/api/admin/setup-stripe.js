import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    // Only allow POST or a specific secret to prevent accidental runs
    const { secret } = req.query;
    if (secret !== process.env.STRIPE_SECRET_KEY && req.method !== 'POST') {
        return res.status(401).json({ error: 'Unauthorized. Please provide your Stripe Secret Key as a "secret" query param.' });
    }

    try {
        console.log('🚀 Starting Stripe Setup via API...');

        // 1. Create Usage Meters
        const apiMeter = await stripe.billing.meters.create({
            display_name: 'Hermes API Calls',
            event_name: 'hermes_api_call',
            default_aggregation: { formula: 'count' },
        });

        const chatMeter = await stripe.billing.meters.create({
            display_name: 'Chat Messages',
            event_name: 'chat_message',
            default_aggregation: { formula: 'count' },
        });

        // 2. Create Products
        const products = [
            { name: 'Nexus Retail', description: '1 Active Asset, Standard Routing, Discord Alerts', metadata: { tier: 'RETAIL' } },
            { name: 'Nexus Pro', description: '5 Active Assets, High-Priority, Agentic Reflection, Multi-TF X-Ray', metadata: { tier: 'PRO' } },
            { name: 'Nexus Institutional', description: 'Unlimited Assets, Colocated HFT Speeds, Full Order Book Depth', metadata: { tier: 'INSTITUTIONAL' } }
        ];

        const createdProducts = [];
        for (const p of products) {
            const product = await stripe.products.create(p);
            createdProducts.push(product);
        }

        // 3. Create Prices
        const priceConfigs = [
            { product: createdProducts[0].id, unit_amount: 4900, tier: 'RETAIL' },
            { product: createdProducts[1].id, unit_amount: 14900, tier: 'PRO' },
            { product: createdProducts[2].id, unit_amount: 49900, tier: 'INSTITUTIONAL' }
        ];

        const envVars = {};
        for (const config of priceConfigs) {
            const price = await stripe.prices.create({
                product: config.product,
                unit_amount: config.unit_amount,
                currency: 'usd',
                recurring: { interval: 'month' },
                metadata: { tier: config.tier }
            });
            envVars[`STRIPE_PRICE_${config.tier}`] = price.id;
        }

        res.status(200).json({
            status: 'Success',
            message: 'Stripe setup complete. Add these to your Vercel Environment Variables.',
            env: {
                ...envVars,
                STRIPE_METER_API: apiMeter.id,
                STRIPE_METER_CHAT: chatMeter.id
            }
        });

    } catch (error) {
        console.error('[STRIPE_SETUP_API_ERROR]:', error.message);
        res.status(500).json({ error: error.message });
    }
}
