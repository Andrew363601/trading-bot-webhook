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
  const { strategy, version, config, asset } = req.body;

  if (!strategy || !version || !config || !asset) {
    return res.status(400).json({ error: 'Missing strategy, version, asset, or config' });
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
        is_active: true,
        updated_at: new Date().toISOString()
    }, { onConflict: ['tenant_id', 'asset'] });

    if (error) throw error

    return res.status(200).json({ message: `✅ Strategy ${strategy} deployed for ${asset}` })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}

export default withTenantAuth(handler);
