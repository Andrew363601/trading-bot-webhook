// pages/api/subscribe-strategy.js
// Subscribe a tenant to a strategy for a specific asset

import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-supabase-jwt-secret');
    tenantId = decoded.sub; // Supabase JWT has user ID as 'sub'
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

    // Check if strategy_config already exists for this asset + strategy
    const { data: existing } = await supabase
      .from('strategy_config')
      .select('id')
      .eq('tenant_id', actualTenantId)
      .eq('asset', asset)
      .eq('strategy', strategy)
      .single();

    if (existing) {
      return res.status(409).json({ 
        error: 'Strategy already subscribed for this asset',
        id: existing.id
      });
    }

    // Create new strategy_config entry
    const { data, error } = await supabase
      .from('strategy_config')
      .insert([{
        tenant_id: actualTenantId,
        asset,
        strategy,
        exchange,
        product_type,
        parameters,
        is_active: true,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      message: 'Strategy subscribed successfully',
      config: data
    });
  } catch (error) {
    console.error('[SUBSCRIBE STRATEGY ERROR]:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
