// pages/api/subscribe-strategy.js
// Subscribe a tenant to a strategy for a specific asset

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
import { getConcurrentStrategyQuota, checkHasCoinbaseKeys } from '../../lib/tenant-context.js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));

const supabase = createClient(
  supabaseUrl,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { asset, strategy, exchange = 'COINBASE', product_type = 'FUTURES', parameters = {}, force_replace = false } = req.body;

  if (!asset || !strategy) {
    return res.status(400).json({ error: 'Missing asset or strategy' });
  }

  // Phase 3.4: Extract execution_mode from parameters with LIVE gating
  const executionMode = parameters?.execution_mode || 'PAPER';
  const isCDEAsset = (asset || '').toString().toUpperCase().includes('-CDE');
  // If LIVE requested but asset is not CDE, reject
  if (executionMode === 'LIVE' && !isCDEAsset) {
    return res.status(400).json({
      error: 'LIVE mode is restricted to Coinbase CDE futures only. Use PAPER mode for non-CDE assets.',
      source: req.body?.source
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

    // 🔒 LIVE MODE GATE: Block LIVE activation if Coinbase API keys aren't configured.
    // (deploy-strategy.js had this; subscribe-strategy.js was missing it — closing that gap.)
    if (executionMode === 'LIVE') {
      try {
        const secrets = await retrieveAPIKey(supabase, actualTenantId, 'COINBASE');
        if (!secrets?.apiKey || !secrets?.apiSecret) {
          return res.status(400).json({
            error: 'LIVE trading requires Coinbase API keys. Add them in Settings → API Keys, or switch to PAPER mode to start simulated trading.'
          });
        }
      } catch (e) {
        return res.status(400).json({
          error: 'LIVE trading requires Coinbase API keys. Add them in Settings → API Keys, or switch to PAPER mode to start simulated trading.'
        });
      }
    }

    // 1. Check for any existing active strategy for this asset and tenant
    const { data: existingActiveStrategies, error: activeError } = await supabase
      .from('strategy_config')
      .select('id, strategy, parameters') // Select id and parameters to preserve them
      .eq('tenant_id', actualTenantId)
      .eq('asset', asset)
      .eq('is_active', true);

    // DEACTIVATE any currently active strategy on this asset (enforce 1-active-per-asset limit)
    // NOTE: This runs BEFORE the quota check because if we are replacing an active strategy,
    // we don't want it to erroneously trigger the max-concurrent limit.
    if (existingActiveStrategies && existingActiveStrategies.length > 0) {
      const idsToDeactivate = existingActiveStrategies.map(s => s.id);
      
      const { error: deactivateError } = await supabase
        .from('strategy_config')
        .update({ is_active: false })
        .in('id', idsToDeactivate);

      if (deactivateError) {
        console.error('Error deactivating existing strategies:', deactivateError);
        // Continue anyway; the unique DB constraint (if added) or just cleanup
        // will handle it, but we log the issue.
      }
    }

    // 🪟 PLAN GATE: enforce per-tier ceiling on concurrently active strategies.
    // Reactivating an existing strategy of THIS asset is fine (it doesn't grow the
    // active count); only block when adding a NEW active row beyond the quota.
    {
      const quota = await getConcurrentStrategyQuota(actualTenantId);
      // Because we just deactivated conflicting strategies, the active count is true.
      // If quota.hasRoom is false now, they literally cannot add another one.
      if (!quota.hasRoom) {
        return res.status(403).json({
          error: `Your ${quota.tier} plan allows up to ${quota.limit} active strategy${quota.limit === 1 ? '' : 'ies'} at a time (currently ${quota.active}). Deactivate another strategy or upgrade your plan to add more.`,
          quota
        });
      }
    }

    // 2. Check if the specific strategy-asset combo already exists for this tenant
    const { data: existingStrategy, error: existingError } = await supabase
      .from('strategy_config')
      .select('id, parameters')
      .eq('tenant_id', actualTenantId)
      .eq('asset', asset)
      .eq('strategy', strategy)
      .maybeSingle();

    if (activeError) {
      console.error("[SUBSCRIBE STRATEGY ERROR]: Failed to check for active strategies:", activeError.message);
      return res.status(500).json({ error: "Failed to check active strategies.", details: activeError.message });
    }

    const currentActiveStrategy = existingActiveStrategies?.[0];

    // 2. Enforce "one active strategy per asset" rule.
    // 🛡️ ACCOUNT PROTECTION: Two strategies active on the same asset (LIVE or PAPER)
    // can issue conflicting orders and cause unexpected position closures. We allow the
    // user to *replace* the active strategy, but only with an explicit confirmation
    // (force_replace=true) so it is never silent.
    if (currentActiveStrategy && currentActiveStrategy.strategy !== strategy) {
      if (!force_replace) {
        // Signal the UI to show a confirmation popup before overriding.
        return res.status(409).json({
          conflict: true,
          asset,
          active_strategy: currentActiveStrategy.strategy,
          requested_strategy: strategy,
          error: `Only one strategy can be active at a time for ${asset}. Activating "${strategy}" will deactivate "${currentActiveStrategy.strategy}".`,
        });
      }
      // Explicit override confirmed: deactivate the conflicting active strategy first.
      const { error: deactivateError } = await supabase
        .from('strategy_config')
        .update({ is_active: false, last_updated: new Date().toISOString() })
        .eq('tenant_id', actualTenantId)
        .eq('asset', asset)
        .eq('is_active', true)
        .neq('strategy', strategy);
      if (deactivateError) {
        console.error("[SUBSCRIBE STRATEGY ERROR]: Failed to deactivate conflicting strategy:", deactivateError.message);
        return res.status(500).json({ error: "Failed to replace active strategy.", details: deactivateError.message });
      }
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
        execution_mode: executionMode,
        // IMPORTANT: Retain existing parameters, do not overwrite with new 'parameters' from req.body
        // The front-end editor handles parameter changes for existing strategies.
        parameters: existingStrategy.parameters // Use existing parameters
      };
    } else {
      // New strategy - insert it with standard default parameters
      operation = 'insert';
      const defaultParameters = {
        qty: 1,
        leverage: 1,
        macro_tf: "ONE_HOUR",
        trigger_tf: "FIVE_MINUTE",
        market_type: "FUTURES",
        tripwire_percent: 0.25,
        trail_step_percent: 0.10,
        veto_cooldown_minutes: 10
      };
      // Merge: incoming parameters override defaults
      const mergedParameters = { ...defaultParameters, ...flattenParameters(parameters) };
      finalConfigData = {
        tenant_id: actualTenantId,
        asset,
        strategy,
        exchange,
        product_type,
        parameters: mergedParameters,
        execution_mode: executionMode,
        is_active: true,
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
      console.error(`[SUBSCRIBE STRATEGY ERROR]: Failed to ${operation} strategy:`, resultError.message, "Data:", JSON.stringify(finalConfigData, null, 2));
      return res.status(500).json({ error: `Failed to ${operation} strategy.`, details: resultError.message });
    }

    return res.status(201).json({
                  message: `Successfully ${operation === 'insert' ? 'subscribed to' : 'activated'} strategy`,
      config: resultData
    });
  } catch (error) {
    console.error('[SUBSCRIBE STRATEGY FATAL ERROR]: Uncaught error in subscribe-strategy API:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

function flattenParameters(params) {
  if (!params) return {};

  const flattened = {};
  for (const key in params) {
    const value = params[key];
    if (typeof value === 'object' && value !== null && ('default' in value || 'value' in value)) {
      flattened[key] = value.value !== undefined ? value.value : value.default;
    } else {
      flattened[key] = value;
    }
  }
  return flattened;
}
