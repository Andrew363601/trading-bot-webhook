// pages/api/subscribe-strategy.js
// Subscribe a tenant to a strategy for a specific asset

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

  const { asset, strategy, exchange = 'COINBASE', product_type = 'FUTURES', parameters = {} } = req.body;

  if (!asset || !strategy) {
    return res.status(400).json({ error: 'Missing asset or strategy' });
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
    tenantId = payload.sub; // Supabase JWT has user ID as 'sub'
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

    // Construct the data for the strategy configuration
    const configData = {
        tenant_id: actualTenantId,
        asset,
        strategy,
        exchange,
        product_type,
        parameters,
        is_active: true,
        updated_at: new Date().toISOString()
    };

    // Upsert the strategy configuration.
    // The onConflict columns MUST match a UNIQUE index in Supabase.
    const { data, error } = await supabase
      .from('strategy_config')
      .upsert(configData, { 
        onConflict: 'asset, strategy, tenant_id',
        ignoreDuplicates: false // We want to update if it exists
      })
      .select()
      .single();

    if (error) {
      console.error("[SUBSCRIBE STRATEGY ERROR]:", error.message, "Data:", configData);
      return res.status(500).json({ error: "Failed to subscribe to strategy.", details: error.message });
    }

    return res.status(201).json({
      message: "Successfully subscribed to strategy",
      config: data
    });
  } catch (error) {
    console.error('[SUBSCRIBE STRATEGY FATAL ERROR]: Uncaught error in subscribe-strategy API:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
