// pages/api/strategy-config-update.js
// Update strategy configuration parameters

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));

const supabase = createClient(
  supabaseUrl,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// FIX 41: write-path allowlist for TF params — prevents sniper-death configs
// (sub-30m macro TFs / unsupported trigger TFs) from ever being written.
// Only keys present in the incoming `parameters` payload are validated;
// legacy stored values are accepted unchanged.
const TF_ALLOWLIST = {
  macro_tf: ['THIRTY_MINUTE', 'ONE_HOUR', 'TWO_HOUR', 'SIX_HOUR', 'ONE_DAY'],
  trigger_tf: ['FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE', 'ONE_HOUR'],
};

function validateTfParams(parameters) {
  const errors = [];
  for (const [key, allowed] of Object.entries(TF_ALLOWLIST)) {
    if (parameters[key] === undefined) continue;
    if (!allowed.includes(String(parameters[key]).toUpperCase())) {
      errors.push(`${key} must be one of: ${allowed.join(', ')}`);
    }
  }
  return errors;
}

// Push F: veto_cooldown_minutes — optional integer override (minutes), 1–1440.
// Empty string / null / undefined = clear the override (worker falls back to the
// TF-scaled default). Non-numeric or out-of-range values are rejected with 400.
// NOTE: this field is PROTECTED in genetic-optimizer.js — never optimizer-mutable.
function validateVetoCooldown(parameters) {
  if (parameters.veto_cooldown_minutes === undefined) return [];
  const raw = parameters.veto_cooldown_minutes;
  if (raw === null || raw === '') {
    parameters.veto_cooldown_minutes = null; // explicit clear
    return [];
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 1440) {
    return ['veto_cooldown_minutes must be an integer between 1 and 1440 (minutes), or empty to clear'];
  }
  parameters.veto_cooldown_minutes = num;
  return [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { strategy_config_id, parameters = {}, is_active } = req.body;

  if (!strategy_config_id) {
    return res.status(400).json({ error: 'Missing strategy_config_id' });
  }

  // FIX 41: reject unsupported TF values before any write.
  const tfErrors = validateTfParams(parameters);
  if (tfErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid timeframe configuration',
      details: tfErrors,
      allowed: TF_ALLOWLIST,
    });
  }

  // Push F: reject invalid veto_cooldown_minutes before any write.
  const vetoErrors = validateVetoCooldown(parameters);
  if (vetoErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid veto_cooldown_minutes',
      details: vetoErrors,
    });
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
      // If user explicitly toggles a strategy, clear any automated billing pause flag
      updateData.billing_paused = false;
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
