// pages/api/quick-start.js
// API endpoint to save/load Quick Start Guide state for a tenant.

import { withTenantAuth } from '../../lib/auth-middleware';

async function handler(req, res) {
  const { tenantId, supabase } = req.tenant;

  if (req.method === 'POST') {
    // Save quick start state
    try {
      const { dismissed, step } = req.body;

      const updateData = {};
      if (dismissed !== undefined) updateData.quick_start_dismissed = dismissed;
      if (step !== undefined) updateData.quick_start_step = step;
      updateData.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from('tenant_settings')
        .upsert({
          tenant_id: tenantId,
          ...updateData
        }, { onConflict: 'tenant_id' });

      if (error) throw error;

      return res.status(200).json({ status: 'success' });
    } catch (error) {
      console.error('[QUICK_START_API_ERROR]', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET') {
    // Load quick start state
    try {
      const { data, error } = await supabase
        .from('tenant_settings')
        .select('quick_start_dismissed, quick_start_step, risk_assessment_complete')
        .eq('tenant_id', tenantId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      return res.status(200).json({
        dismissed: data?.quick_start_dismissed || false,
        step: data?.quick_start_step || 0,
        riskAssessmentComplete: data?.risk_assessment_complete || false
      });
    } catch (error) {
      console.error('[QUICK_START_API_ERROR]', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withTenantAuth(handler);