// pages/api/deploy-strategy.js
import { createClient } from '@supabase/supabase-js'
import { withTenantAuth } from '../../lib/auth-middleware';

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
      const { data: keyData } = await supabase
        .from('api_keys_vault')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('exchange', 'COINBASE')
        .eq('is_active', true)
        .single();

      if (!keyData) {
        return res.status(400).json({
          error: 'LIVE trading requires Coinbase API keys. Please configure them in Settings first, or switch to PAPER mode to start simulated trading.'
        });
      }
    } catch (e) {
      return res.status(400).json({
        error: 'Could not verify API keys. Please ensure your Coinbase API keys are configured in Settings before deploying in LIVE mode.'
      });
    }
  }

  try {
    // Step 1: Deactivate any active strategy FOR THIS TENANT AND ASSET
    await supabase.from('strategy_config')
      .update({ is_active: false })
      .eq('tenant_id', tenantId)
      .eq('asset', asset);

    // Step 2: Upsert the new configuration
    const { error } = await supabase.from('strategy_config').upsert({
        tenant_id: tenantId,
        strategy,
        version,
        config,
        asset,
        execution_mode: execution_mode || 'PAPER',
        is_active: true,
        updated_at: new Date().toISOString()
    }, { onConflict: ['tenant_id', 'asset'] });

    if (error) throw error

    return res.status(200).json({ message: `✅ Strategy ${strategy} deployed for ${asset} in ${execution_mode || 'PAPER'} mode` })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: 'Failed to deploy strategy. Please try again.' })
  }
}

export default withTenantAuth(handler);
