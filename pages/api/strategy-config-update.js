// pages/api/strategy-config-update.js
// Update strategy configuration parameters

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { createClient } from '@supabase/supabase-js';

const JWKS = createRemoteJWKSet(new URL('https://wsrioyxzhxxrtzjncfvn.supabase.co/auth/v1/.well-known/jwks.json'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { strategy_config_id, parameters = {}, is_active } = req.body;

  if (!strategy_config_id) {
    return res.status(400).json({ error: 'Missing strategy_config_id' });
  }

  // Verify JWT and extract tenant_id
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let tenantId;
  try {
    const token = authHeader.split(' ')[1];
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
    tenantId = payload.sub;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // Get tenant_id from user_id
    const { data: tenantUser, error: tuError } = await supabase
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', tenantId)
      .single();

    if (tuError || !tenantUser) {
      return res.status(401).json({ error: 'Tenant not found' });
    }

    const actualTenantId = tenantUser.tenant_id;

    // Verify that this config belongs to the user's tenant
    const { data: config, error: configError } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('id', strategy_config_id)
      .eq('tenant_id', actualTenantId)
      .single();

    if (configError || !config) {
      return res.status(404).json({ error: 'Strategy config not found' });
    }

    // Build update object
    const updateData = {};
    if (parameters && Object.keys(parameters).length > 0) {
      updateData.parameters = { ...config.parameters, ...parameters };
    }
    if (is_active !== undefined) {
      updateData.is_active = is_active;
    }
    updateData.updated_at = new Date().toISOString();
    updateData.tenant_id = actualTenantId; // Security: Ensure tenant_id is preserved

    // Update the config
    const { data: updated, error: updateError } = await supabase
      .from('strategy_config')
      .update(updateData)
      .eq('id', strategy_config_id)
      .eq('tenant_id', actualTenantId) // Security: Ensure row belongs to tenant
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // Log usage if this is an update (for billing purposes)
    await supabase
      .from('usage_logs')
      .insert([{
        tenant_id: actualTenantId,
        action: 'STRATEGY_CONFIG_UPDATE',
        details: { strategy_config_id, updatedFields: Object.keys(updateData) },
        created_at: new Date().toISOString()
      }]);

    return res.status(200).json({
      message: 'Strategy config updated successfully',
      config: updated
    });
  } catch (error) {
    console.error('[STRATEGY CONFIG UPDATE ERROR]:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
