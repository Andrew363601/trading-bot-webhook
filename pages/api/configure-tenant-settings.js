// pages/api/configure-tenant-settings.js
import { withTenantAuth } from '../../lib/auth-middleware';

/**
 * API Endpoint for tenants to configure their settings (notifications, risk profile, quick start).
 */
async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { 
            notification_webhook_url,
            account_balance_usd,
            risk_per_trade_percent,
            max_position_size_usd,
            max_leverage,
            max_daily_loss_usd,
            daily_roi_target_usd,
            max_concurrent_trades,
            allowed_assets,
            risk_assessment_complete,
            quick_start_dismissed,
            quick_start_step,
            agent_open_trade_enabled,
            agent_open_trade_reverse,
            agent_open_trade_close,
            agent_open_trade_adjust_tp_sl,
            agent_open_trade_tripwire_adjust,
            agent_taker_fee_rate
        } = req.body;
        const { tenantId, supabase, role } = req.tenant;

        if (role !== 'ADMIN' && role !== 'TRADER') {
            return res.status(403).json({ error: 'Unauthorized role' });
        }

        // Build update payload with only provided fields
        const updateData = { tenant_id: tenantId, updated_at: new Date().toISOString() };
        
        if (notification_webhook_url !== undefined) {
          // Basic URL validation
          if (notification_webhook_url && !notification_webhook_url.startsWith('https://')) {
            return res.status(400).json({ error: 'Webhook URL must start with https://' });
          }
          updateData.notification_webhook_url = notification_webhook_url;
        }
        if (account_balance_usd !== undefined) updateData.account_balance_usd = account_balance_usd;
        if (risk_per_trade_percent !== undefined) updateData.risk_per_trade_percent = risk_per_trade_percent;
        if (max_position_size_usd !== undefined) updateData.max_position_size_usd = max_position_size_usd;
        if (max_leverage !== undefined) updateData.max_leverage = max_leverage;
        if (max_daily_loss_usd !== undefined) updateData.max_daily_loss_usd = max_daily_loss_usd;
        if (daily_roi_target_usd !== undefined) updateData.daily_roi_target_usd = daily_roi_target_usd;
        if (max_concurrent_trades !== undefined) updateData.max_concurrent_trades = max_concurrent_trades;
        if (allowed_assets !== undefined) updateData.allowed_assets = allowed_assets;
        if (risk_assessment_complete !== undefined) updateData.risk_assessment_complete = risk_assessment_complete;
        if (quick_start_dismissed !== undefined) updateData.quick_start_dismissed = quick_start_dismissed;
        if (quick_start_step !== undefined) updateData.quick_start_step = quick_start_step;
        if (agent_open_trade_enabled !== undefined) updateData.agent_open_trade_enabled = agent_open_trade_enabled;
        if (agent_open_trade_reverse !== undefined) updateData.agent_open_trade_reverse = agent_open_trade_reverse;
        if (agent_open_trade_close !== undefined) updateData.agent_open_trade_close = agent_open_trade_close;
        if (agent_open_trade_adjust_tp_sl !== undefined) updateData.agent_open_trade_adjust_tp_sl = agent_open_trade_adjust_tp_sl;
        if (agent_open_trade_tripwire_adjust !== undefined) updateData.agent_open_trade_tripwire_adjust = agent_open_trade_tripwire_adjust;
        if (agent_taker_fee_rate !== undefined) updateData.agent_taker_fee_rate = agent_taker_fee_rate;

        // Update or insert tenant settings
        const { error } = await supabase
            .from('tenant_settings')
            .upsert(updateData, { onConflict: 'tenant_id' });

        if (error) throw error;

        return res.status(200).json({ status: 'success', message: 'Tenant settings updated.' });
    } catch (error) {
        console.error('[CONFIG_TENANT_SETTINGS_ERROR]', error.message);
        return res.status(500).json({ error: error.message });
    }
}

export default withTenantAuth(handler);
