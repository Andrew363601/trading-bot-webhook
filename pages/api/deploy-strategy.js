// pages/api/deploy-strategy.js
import { createClient } from '@supabase/supabase-js'
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
import { setPendingMode, consumePendingMode, isPendingMode } from '../../lib/phase3-mode.js';

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
    // Determine asset category and normalize execution mode
    const isCDEAsset = (asset || '').toString().toUpperCase().includes('-CDE');
    // Phase 3.4: UI flow differentiation - prompt for mode depending on source (chat vs UI)
    const source = req.body?.source;
    let pendingModeFlag = false;
    if (execution_mode === undefined) {
      pendingModeFlag = true;
      // If LIVE not requested (or asset not CDE), default to PAPER with a pending mode prompt
      setPendingMode(tenantId, asset, 'PAPER');
    }
    // If LIVE requested but asset is not a CDE, reject with guidance
    if (execution_mode === 'LIVE' && !isCDEAsset) {
      return res.status(400).json({ error: 'LIVE mode is restricted to Coinbase CDE futures only. Use PAPER mode for non-CDE assets.' });
    }
    // If LIVE requested without API keys, reject with guidance
    const modeToPersist = (execution_mode === 'LIVE' && isCDEAsset) ? 'LIVE' : (execution_mode || 'PAPER');

    // Build payload for upsert using the canonical strategy name in `strategy`
    let payload = {
      tenant_id: tenantId,
      strategy,
      version,
      config,
      asset,
      execution_mode: modeToPersist,
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
    // If there is a pending mode prompt for this strategy, resolve it now
    if (isPendingMode(tenantId, asset)) {
      payload.execution_mode = consumePendingMode(tenantId, asset) || payload.execution_mode;
    }
    let { error } = await supabase.from('strategy_config').upsert(payload, { onConflict: ['tenant_id', 'asset'] });
    if (error) throw error

    // Build response with per-source prompt fields
    const responseMode = payload.execution_mode || 'PAPER';
    const pendingState = (typeof pendingModeFlag !== 'undefined' && pendingModeFlag) || isPendingMode(tenantId, asset);
    const responseChatPrompt = (source === 'chat' && pendingState)
      ? `Please choose mode for ${strategy} on ${asset}: LIVE or PAPER? (LIVE requires Coinbase CDE futures and API keys)`
      : undefined;
    const responseUiPrompt = (source !== 'chat' && pendingState);
    return res.status(200).json({
      message: `✅ Strategy ${strategy} deployed for ${asset} in ${responseMode} mode`,
      pending_mode: !!pendingState,
      chat_prompt: responseChatPrompt || null,
      ui_prompt: responseUiPrompt || false
    })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: 'Failed to deploy strategy. Please try again.' })
  }
}

export default withTenantAuth(handler);
