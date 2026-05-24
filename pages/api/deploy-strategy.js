// pages/api/deploy-strategy.js
import { createClient } from '@supabase/supabase-js'
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { tenantId } = req.tenant;
  const { strategy, version, config, asset, execution_mode } = req.body;

  if (!strategy || !version || !config || !asset) {
    return res.status(400).json({ error: 'Missing strategy, version, asset, or config' });
  }

  // Validate config is an object
  if (typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'Config must be a valid JSON object' });
  }

  // 🔒 LIVE MODE GATE: Check if tenant has Coinbase API keys before allowing LIVE deployment
  if (execution_mode === 'LIVE') {
    try {
      // Verify keys exist in vault AND that MASTER_ENCRYPTION_KEY can decrypt them
      const secrets = await retrieveAPIKey(supabase, tenantId, 'COINBASE');
      if (!secrets.apiKey || !secrets.apiSecret) {
        return res.status(400).json({
          error: 'LIVE trading requires Coinbase API keys. Please configure them in Settings first, or switch to PAPER mode to start simulated trading.'
        });
      }
    } catch (e) {
      const isKeyConfig = e.message.includes('Keys not found') || e.message.includes('Empty keys');
      return res.status(400).json({
        error: isKeyConfig
          ? 'LIVE trading requires Coinbase API keys. Please configure them in Settings first, or switch to PAPER mode to start simulated trading.'
          : `Cannot decrypt API keys: ${e.message}. MASTER_ENCRYPTION_KEY may be missing from server environment.`
      });
    }
  }

  try {
    // Phase 3.2: Persist using the existing 'strategy' column (no separate strategy_name)
    // Build payload for upsert using the canonical strategy name in `strategy`
    let payload = {
      tenant_id: tenantId,
      strategy,
      version,
      config,
      asset,
      execution_mode: execution_mode || 'PAPER',
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // Step 1: Deactivate any active strategy FOR THIS TENANT AND ASSET
    await (async () => {
      try {
        await supabase.from('strategy_config')
          .update({ is_active: false })
          .eq('tenant_id', tenantId)
          .eq('asset', asset);
      } catch (e) {
        console.warn('[DEPLOY_STRATEGY] Could not deactivate previous strategies:', e.message);
      }
    })();

    // Step 2: Upsert the new configuration
    let { error } = await supabase.from('strategy_config').upsert(payload, { onConflict: ['tenant_id', 'asset'] });
    if (error) throw error

    return res.status(200).json({ message: `✅ Strategy ${strategy} deployed for ${asset} in ${execution_mode || 'PAPER'} mode` })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: 'Failed to deploy strategy. Please try again.' })
  }
}

export default withTenantAuth(handler);
