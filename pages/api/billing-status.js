import { verifyTenantContext } from '../../lib/auth-middleware';
import { getBillingStatus } from '../../lib/billing-status';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        let tenantContext;
        try {
            tenantContext = await verifyTenantContext(req);
        } catch (authErr) {
            return res.status(401).json({ error: authErr.message });
        }

        const tenantId = tenantContext.tenantId;
        const status = await getBillingStatus(tenantId);

        return res.status(200).json(status);
    } catch (err) {
        console.error('[API_BILLING_STATUS] Internal error:', err);
        return res.status(500).json({ error: err.message || 'Failed to retrieve billing status' });
    }
}
