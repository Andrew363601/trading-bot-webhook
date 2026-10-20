// pages/api/deploy-strategy.js
import { createClient } from '@supabase/supabase-js'
import { withTenantAuth } from '../../lib/auth-middleware';
import { retrieveAPIKey } from '../../lib/secrets-manager.js';
import { setPendingMode, consumePendingMode, isPendingMode } from '../../lib/phase3-mode.js';
import { getConcurrentStrategyQuota } from '../../lib/tenant-context.js';
import { resolveStrategy } from '../../lib/strategy-resolver.js';
// 🟢 PUSH AM53 — regime-conditional exit map validation (deploy-time dry-check).
import { validateRegimeParamsMap } from '../../lib/regime-params.js';

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

  // 🟢 PUSH AM63 (Push 3) — venue stamp. strategy_config.exchange is a canonical
  // LOWERCASE routing column. Normalize the caller's venue and refuse an unknown
  // one LOUDLY (same shape as the router) rather than silently writing coinbase.
  // 🟢 PUSH AM63 (Push 5) — 'krakenfutures' (real Kraken Futures apiv3) admitted so
  // Studio can deploy the KRF universe (paper-only until Push 6).
  // 🟢 AM68 — 'krakenspot' (Kraken SPOT + margin) admitted; LIVE allowed with the
  // KRAKENSPOT vault row.
  const KNOWN_EXCHANGES = ['coinbase', 'kraken', 'krakenfutures', 'krakenspot'];
  const deployExchange = (req.body.exchange || 'coinbase').toString().toLowerCase();
  if (!KNOWN_EXCHANGES.includes(deployExchange)) {
    return res.status(400).json({ error: `[AM63] unsupported exchange '${deployExchange}'` });
  }

  // Validate config is an object
  if (typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'Config must be a valid JSON object' });
  }

  // 🟢 PUSH AM53 — DEPLOY DRY-CHECK: reject an invalid regime_params map at the
  // door, not at 3am in the scan loop. Uses validateRegimeParamsMap() DIRECTLY
  // (never the resolver) so the check is regime-independent — a deploy has no
  // canon regime to resolve against, and the resolver would skip validation
  // when the regime is null.
  try {
    validateRegimeParamsMap(config.regime_params);
  } catch (regimeErr) {
    const msg = regimeErr?.error || regimeErr?.message || String(regimeErr);
    console.error(`[DEPLOY_STRATEGY] ❌ Invalid regime_params for ${strategy}/${asset}: ${msg}`);
    return res.status(400).json({ error: msg });
  }

  // 🧭 RESOLVE GATE: the strategy must be a built-in OR a library row this
  // tenant owns OR a public library row. Anything else is rejected loudly.
  try {
    const resolved = await resolveStrategy(strategy, tenantId);
    if (resolved.source === 'none') {
      return res.status(400).json({ error: `Unknown strategy ${strategy}` });
    }
  } catch (e) {
    return res.status(500).json({ error: `Strategy resolution failed: ${e.message}` });
  }

  // 🔒 LIVE MODE GATE: Check if the tenant has the venue's API keys before allowing
  // LIVE deployment. 🟢 PUSH AM64 — venue-aware: coinbase → COINBASE vault row;
  // krakenfutures → KRAKENFUTURES vault row (apiv3, KRF LIVE lane shipped Push 7);
  // kraken → refused below (PAPER-only until Push 8). The vault venue literal is
  // UPPERCASE (secrets-manager normalizes with toUpperCase on read) — do NOT
  // lowercase; the asymmetry with routing columns is by design.
  if (execution_mode === 'LIVE') {
    if (deployExchange === 'kraken') {
      // 🟢 AM68 — US-futures API reality (Kraken specialist verdict, Oct 18 2026).
      return res.status(400).json({
        error: 'Kraken has no US-futures API: the KRF/DRV doors serve the international platform (geo-blocked for US accounts). US derivatives API = a Tradovate account (per Kraken). This venue stays PAPER-only.',
        reason: 'US_FUTURES_NO_KRAKEN_API'
      });
    }
    const vaultVenue = deployExchange === 'krakenfutures' ? 'KRAKENFUTURES'
      : deployExchange === 'krakenspot' ? 'KRAKENSPOT'
      : 'COINBASE';
    try {
      // Verify keys exist in vault AND that MASTER_ENCRYPTION_KEY can decrypt them
      const secrets = await retrieveAPIKey(supabase, tenantId, vaultVenue);
      if (!secrets.apiKey || !secrets.apiSecret) {
        return res.status(400).json({
          error: `LIVE trading requires ${vaultVenue} API keys. Please configure them in Settings first, or switch to PAPER mode to start simulated trading.`
        });
      }
    } catch (e) {
      const isKeyConfig = e.message.includes('Keys not found') || e.message.includes('Empty keys');
      return res.status(400).json({
        error: isKeyConfig
          ? `LIVE trading requires ${vaultVenue} API keys. Please configure them in Settings first, or switch to PAPER mode to start simulated trading.`
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
    // 🟢 PUSH AM64 — CDE restriction is COINBASE-scoped (krakenfutures LIVE is
    // allowed; kraken was already refused above).
    // 🟢 AM68 — krakenfutures + krakenspot LIVE are allowed (krakenspot needs the
    // KRAKENSPOT vault row, checked above).
    if (execution_mode === 'LIVE' && deployExchange !== 'krakenfutures' && deployExchange !== 'krakenspot' && !isCDEAsset) {
      return res.status(400).json({ error: 'LIVE mode is restricted to Coinbase CDE futures only. Use PAPER mode for non-CDE assets.' });
    }
    // If LIVE requested without API keys, reject with guidance
    const modeToPersist = (execution_mode === 'LIVE' && (deployExchange === 'krakenfutures' || deployExchange === 'krakenspot' || isCDEAsset)) ? 'LIVE' : (execution_mode || 'PAPER');

    // Build payload for upsert using the canonical strategy name in `strategy`.
    // Column fix (AM48): the strategy_config table exposes `parameters` and
    // `last_updated`; `config` / `updated_at` do not exist and caused upsert 500s
    // when sent (AM48b cleanup).
    const nowIso = new Date().toISOString();
    let payload = {
      tenant_id: tenantId,
      strategy,
      version,
      parameters: config,
      asset,
      exchange: deployExchange,
      execution_mode: modeToPersist,
      is_active: true,
      last_updated: nowIso
    };

    // 🪟 PLAN GATE: enforce per-tier ceiling on concurrently active strategies.
    // Reactivating this same (asset, strategy) is fine; only block when it would
    // be a NET-NEW active row beyond the tier quota. We allow per-asset replacement
    // because Step 1 below first deactivates any conflicting active strategy on
    // the same asset (net count does not grow in that case).
    {
      const quota = await getConcurrentStrategyQuota(tenantId);
      const { data: alreadyActiveSame } = await supabase
        .from('strategy_config')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('asset', asset)
        .eq('strategy', strategy)
        .eq('is_active', true)
        .maybeSingle();
      const { data: anyActiveOnAsset } = await supabase
        .from('strategy_config')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('asset', asset)
        .eq('is_active', true)
        .maybeSingle();
      const replacesExistingOnAsset = !!anyActiveOnAsset; // Step 1 will turn that off
      const wouldBeNetNewActive = !alreadyActiveSame && !replacesExistingOnAsset;
      if (wouldBeNetNewActive && !quota.hasRoom) {
        return res.status(403).json({
          error: `Your ${quota.tier} plan allows up to ${quota.limit} active strategy${quota.limit === 1 ? '' : 'ies'} at a time (currently ${quota.active}). Deactivate another strategy or upgrade your plan to add more.`,
          quota
        });
      }
    }

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
    // 🟢 UPSERT FIX: Include 'strategy' in the conflict target so different strategies on the same asset don't overwrite each other
    let { error } = await supabase.from('strategy_config').upsert(payload, { onConflict: ['tenant_id', 'asset', 'strategy'] });
    if (error) throw error

    // Build response with per-source prompt fields
    const responseMode = payload.execution_mode || 'PAPER';
    const pendingState = (typeof pendingModeFlag !== 'undefined' && pendingModeFlag) || isPendingMode(tenantId, asset);
    const responseChatPrompt = (source === 'chat' && pendingState)
      ? `Please choose mode for ${strategy} on ${asset}: LIVE or PAPER? (LIVE requires Coinbase CDE futures and API keys)`
      : undefined;
    const responseUiPrompt = (source !== 'chat' && pendingState);

    // 🟢 PUSH AM52i — version pinning visibility. Echo the deployed config
    // version vs the library's latest version so callers can see drift.
    let libraryLatestVersion = null;
    try {
      const cleanName = String(strategy || '').trim().toLowerCase();
      const { data: libRow } = await supabase
        .from('strategy_library')
        .select('version')
        .eq('name', cleanName)
        .or('tenant_id.eq.' + tenantId + ',visibility.eq.public')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (libRow) libraryLatestVersion = libRow.version;
    } catch (e) {
      console.warn('[DEPLOY_STRATEGY] version echo lookup failed:', e.message);
    }
    const configVersion = Number(version) || null;
    const inSync = libraryLatestVersion == null || configVersion == null
      ? null
      : configVersion === libraryLatestVersion;

    return res.status(200).json({
      message: `✅ Strategy ${strategy} deployed for ${asset} in ${responseMode} mode`,
      pending_mode: !!pendingState,
      chat_prompt: responseChatPrompt || null,
      ui_prompt: responseUiPrompt || false,
      config_version: configVersion,
      library_latest_version: libraryLatestVersion,
      in_sync: inSync
    })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: 'Failed to deploy strategy. Please try again.' })
  }
}

export default withTenantAuth(handler);
