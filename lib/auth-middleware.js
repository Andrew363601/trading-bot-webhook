// lib/auth-middleware.js
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { createClient } from '@supabase/supabase-js';

const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));

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
            .select('tenant_id, role')
            .eq('auth_user_id', decoded.sub)
            .eq('is_active', true)
            .single();

        if (error || !userLink) {
            throw new Error('User not associated with an active tenant');
        }

        return {
            userId: decoded.sub,
            tenantId: userLink.tenant_id,
            role: userLink.role,
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
