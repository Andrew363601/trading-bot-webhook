// pages/api/configure-api-keys.js
import { withTenantAuth } from '../../lib/auth-middleware';
import { storeAPIKey } from '../../lib/secrets-manager';

/**
 * API Endpoint for tenants to securely configure their exchange keys.
 */
async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { exchange, apiKey, apiSecret } = req.body;
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin role required' });
        }

        if (!exchange || !apiKey || !apiSecret) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        await storeAPIKey(supabase, tenantId, exchange, apiKey, apiSecret);

        return res.status(200).json({ status: 'success', message: `${exchange} keys configured.` });
    } catch (error) {
        console.error('[CONFIG_API_KEYS_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
