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

        // 2. Report to Stripe for usage-based billing
        if (stripe) {
            const { data: sub } = await supabase
                .from('subscriptions')
                .select('stripe_subscription_id, status, tenant_id, tenants(role)')
                .eq('tenant_id', tenantId)
                .single();

            // Report usage for everyone (including Admins)
            // Priority: User's Stripe ID > Company Master ID
            const companyId = process.env.STRIPE_COMPANY_CUSTOMER_ID;
            const rawCustomerId = sub?.stripe_customer_id;
            
            // Ensure we have a valid customer ID (not undefined, null, or placeholder like {{CUSTOMER_ID}})
            const customerId = (rawCustomerId && rawCustomerId !== 'undefined' && !rawCustomerId.includes('{{')) 
                ? rawCustomerId 
                : (companyId && companyId !== 'undefined' && !companyId.includes('{{') ? companyId : null);

            if (customerId) {
                // Determine Stripe Meter Event Name based on metric
                const meterMap = {
                    'TRADE_EXECUTED': process.env.STRIPE_METER_TRADE,
                    'HERMES_API_CALL': process.env.STRIPE_METER_API,
                    'CHAT_MESSAGE': process.env.STRIPE_METER_CHAT
                };

                const meterEventName = meterMap[metric];
                
                if (meterEventName) {
                    console.log(`[STRIPE_METER] Reporting ${metric} (event_name: ${meterEventName}) for customer ${customerId}`);

                    try {
                        const event = await stripe.billing.meterEvents.create({
                            event_name: meterEventName,
                            payload: {
                                value: quantity.toString(),
                                stripe_customer_id: customerId
                            }
                        });
                        console.log(`[STRIPE_METER] Success: ${event.identifier}`);
                    } catch (stripeErr) {
                        console.error(`[STRIPE_METER_ERROR] Stripe rejected event:`, stripeErr.message, stripeErr.code);
                    }
                } else {
                    console.warn(`[USAGE_METER] No meter event name configured for metric: ${metric}`);
                }
            } else {
                console.warn(`[USAGE_METER] No valid customer ID found for tenant ${tenantId}. Ensure STRIPE_COMPANY_CUSTOMER_ID is set in Vercel env.`);
            }
        }
    } catch (error) {
        console.error(`[USAGE_METER] Failed to log ${metric} for ${tenantId}:`, error.message);
    }
}
