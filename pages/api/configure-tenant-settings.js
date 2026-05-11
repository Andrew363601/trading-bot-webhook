// pages/api/configure-tenant-settings.js
import { withTenantAuth } from '../../lib/auth-middleware';

/**
 * API Endpoint for tenants to configure their notification settings (e.g., Discord Webhook).
 */
async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { notification_webhook_url } = req.body;
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN' && role !== 'TRADER') {
            return res.status(403).json({ error: 'Unauthorized role' });
        }

        // Update or insert tenant settings
        const { error } = await supabase
            .from('tenant_settings')
            .upsert({ 
                tenant_id: tenantId, 
                notification_webhook_url: notification_webhook_url,
                updated_at: new Date().toISOString()
            }, { onConflict: 'tenant_id' });

        if (error) throw error;

        return res.status(200).json({ status: 'success', message: 'Tenant settings updated.' });
    } catch (error) {
        console.error('[CONFIG_TENANT_SETTINGS_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
