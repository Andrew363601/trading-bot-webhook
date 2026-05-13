// lib/auth-middleware.js
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));

/**
 * Verifies the JWT and extracts tenant context.
 * Expects Bearer token in Authorization header.
 */
export async function verifyTenantContext(req) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new Error('Missing Authorization header');
        }

        const token = authHeader.split(' ')[1];
        const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });

        if (!payload.sub) throw new Error('Invalid token payload');

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        // Fetch the tenant_id linked to this auth user
        const { data: userLink, error } = await supabase
            .from('tenant_users')
            .select('tenant_id, role, tenants(billing_tier, subscription_active)')
            .eq('auth_user_id', payload.sub)
            .eq('is_active', true)
            .single();

        if (error || !userLink) {
            throw new Error('User not associated with an active tenant');
        }

        // Check subscription status
        const isSubscriptionActive = userLink.tenants?.subscription_active;
        const role = userLink.role;

        // Allow ADMIN to bypass, but others must have active subscription
        if (role !== 'ADMIN' && !isSubscriptionActive) {
            throw new Error('Active subscription required to access this resource');
        }

        return {
            userId: payload.sub,
            tenantId: userLink.tenant_id,
            role: role,
            tier: userLink.tenants?.billing_tier,
            supabase // Scoped client
        };
    } catch (error) {
        throw new Error(`Auth Failed: ${error.message}`);
    }
}

/**
 * Higher-Order Function to wrap Next.js API routes with tenant authentication.
 */
export function withTenantAuth(handler) {
    return async (req, res) => {
        try {
            const context = await verifyTenantContext(req);
            req.tenant = context; // Inject context into request
            return handler(req, res);
        } catch (error) {
            console.error('[AUTH_GATEKEEPER] Rejected:', error.message);
            return res.status(401).json({ error: error.message });
        }
    };
}
