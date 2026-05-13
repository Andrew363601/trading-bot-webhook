// lib/usage-meter.js
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { 
      global: { WebSocket: WebSocket },
      realtime: { transport: WebSocket }
    }
);

/**
 * Records a usage event for a tenant and optionally reports to Stripe.
 */
export async function recordUsage(tenantId, metric, quantity = 1) {
    try {
        // 1. Log to Supabase for internal auditing
        const { error: logError } = await supabase
            .from('usage_logs')
            .insert({
                tenant_id: tenantId,
                metric,
                quantity
            });
            
        if (logError) throw logError;

        // 2. Report to Stripe for usage-based billing if available
        if (stripe) {
            const { data: sub } = await supabase
                .from('subscriptions')
                .select('stripe_subscription_id, status')
                .eq('tenant_id', tenantId)
                .single();

            if (sub?.stripe_subscription_id && sub.status === 'active') {
                // Determine Stripe Price/Meter ID based on metric
                const meterMap = {
                    'TRADE_EXECUTED': process.env.STRIPE_METER_TRADE,
                    'HERMES_API_CALL': process.env.STRIPE_METER_API,
                    'CHAT_MESSAGE': process.env.STRIPE_METER_CHAT
                };

                const meterId = meterMap[metric];
                if (meterId) {
                    await stripe.subscriptionItems.createUsageRecord(
                        sub.stripe_subscription_id, // This should be the Subscription Item ID in practice
                        {
                            quantity: quantity,
                            timestamp: Math.floor(Date.now() / 1000),
                            action: 'increment'
                        }
                    );
                }
            }
        }
    } catch (error) {
        console.error(`[USAGE_METER] Failed to log ${metric} for ${tenantId}:`, error.message);
    }
}
