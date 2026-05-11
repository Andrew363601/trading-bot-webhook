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
    console.error("[SUBSCRIBE STRATEGY ERROR]: JWT Verification failed:", err.message);
    return res.status(401).json({ error: 'Invalid token', details: err.message });
  }

  try {
    // Get tenant_id from user_id
    const { data: tenantUser, error: tuError } = await supabase
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', tenantId)
      .single();

    if (tuError) {
      console.error("[SUBSCRIBE STRATEGY ERROR]: Failed to fetch tenant_id from Supabase:", tuError);
      return res.status(500).json({ error: 'Failed to retrieve tenant information', details: tuError.message });
    }
    if (!tenantUser) {
      console.error("[SUBSCRIBE STRATEGY ERROR]: Tenant user not found for auth_user_id:", tenantId);
      return res.status(401).json({ error: 'Tenant not found for this user' });
    }

    const actualTenantId = tenantUser.tenant_id;

    // 1. Check for any existing active strategy for this asset and tenant
    const { data: existingActiveStrategies, error: activeError } = await supabase
      .from('strategy_config')
      .select('id, strategy, parameters') // Select id and parameters to preserve them
      .eq('tenant_id', actualTenantId)
      .eq('asset', asset)
      .eq('is_active', true);

    if (activeError) {
      console.error("[SUBSCRIBE STRATEGY ERROR]: Failed to check for active strategies:", activeError.message);
      return res.status(500).json({ error: "Failed to check active strategies.", details: activeError.message });
    }

    const currentActiveStrategy = existingActiveStrategies?.[0];

    // 2. Enforce "one active strategy per asset" rule
    if (currentActiveStrategy && currentActiveStrategy.strategy !== strategy) {
      // A different strategy is already active for this asset
      return res.status(409).json({
        error: `Only one strategy can be active at a time for ${asset}. Please deactivate "${currentActiveStrategy.strategy}" first.`,
      });
    }

    let finalConfigData;
    let operation; // 'insert' or 'update'
    let existingStrategyId = null;

    // 3. Check if the specific strategy (by name) already exists (active or inactive)
    const { data: existingStrategy, error: findStrategyError } = await supabase
      .from('strategy_config')
      .select('id, parameters') // Fetch ID and existing parameters
      .eq('tenant_id', actualTenantId)
      .eq('asset', asset)
      .eq('strategy', strategy)
      .maybeSingle();

    if (findStrategyError) {
      console.error("[SUBSCRIBE STRATEGY ERROR]: Failed to find existing strategy:", findStrategyError.message);
      return res.status(500).json({ error: "Failed to find existing strategy.", details: findStrategyError.message });
    }

    if (existingStrategy) {
      // Strategy exists (could be inactive or the same active one)
      operation = 'update';
      existingStrategyId = existingStrategy.id;
      finalConfigData = {
        is_active: true,
        last_updated: new Date().toISOString(),
        // IMPORTANT: Retain existing parameters, do not overwrite with new 'parameters' from req.body
        // The front-end editor handles parameter changes for existing strategies.
        parameters: existingStrategy.parameters // Use existing parameters
      };
    } else {
      // New strategy - insert it
      operation = 'insert';
      finalConfigData = {
        tenant_id: actualTenantId,
        asset,
        strategy,
        exchange,
        product_type,
        parameters, // Use new parameters for a new strategy
        is_active: true,
        last_updated: new Date().toISOString(),
      };
    }

    let resultData;
    let resultError;

    if (operation === 'update') {
      const { data, error } = await supabase
        .from('strategy_config')
        .update(finalConfigData)
        .eq('id', existingStrategyId)
        .select()
        .single();
      resultData = data;
      resultError = error;
    } else { // operation === 'insert'
      const { data, error } = await supabase
        .from('strategy_config')
        .insert([finalConfigData])
        .select()
        .single();
      resultData = data;
      resultError = error;
    }

    if (resultError) {
      console.error(`[SUBSCRIBE STRATEGY ERROR]: Failed to ${operation} strategy:`, resultError.message, "Data:", finalConfigData);
      return res.status(500).json({ error: `Failed to ${operation} strategy.`, details: resultError.message });
    }

    return res.status(201).json({
      message: `Successfully ${operation === 'insert' ? 'subscribed to'' : 'activated'} strategy`,
      config: resultData
    });
  } catch (error) {
    console.error('[SUBSCRIBE STRATEGY FATAL ERROR]: Uncaught error in subscribe-strategy API:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
