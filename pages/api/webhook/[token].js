// pages/api/webhook/[token].js
// Token-gated TradingView webhook receiver.
// Checks is_active (pause), last_veto_time (cooldown), then forwards to Hermes agent.
// Coexists with the legacy flat webhook handler at pages/api/webhook.js
// (which uses ?tenant_id= query param auth).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HERMES_ENDPOINT = process.env.HERMES_WEBHOOK_URL || 'http://localhost:8000/api/wake';

// 🟢 AM72 — LOUD-fail helpers (best-effort; never throw into the request path).
async function sendDiscordAlert(tenantId, { title, description, color }) {
  if (!tenantId) return;
  try {
    const { data: settings } = await supabase
      .from('tenant_settings')
      .select('notification_webhook_url')
      .eq('tenant_id', tenantId)
      .single();
    const webhookUrl = settings?.notification_webhook_url || process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    const embed = { title, color, timestamp: new Date().toISOString() };
    let desc = description || '';
    if (desc.length > 3800) {
      desc = desc.slice(0, 2000) + '\n\n…[truncated]…\n\n' + desc.slice(-1600);
    }
    embed.description = desc;
    await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) {
    console.error('[WEBHOOK DISCORD ALERT] Failed:', e.message);
  }
}

async function logAgentActivity(tenantId, agentName, asset, logMessage, logType = 'ERROR') {
  try {
    await supabase.from('agent_session_logs').insert([{
      tenant_id: tenantId, agent_name: agentName, asset, log_message: logMessage,
      log_type: logType, timestamp: new Date().toISOString(),
    }]);
  } catch (e) {
    console.error('[WEBHOOK AGENT LOG] Failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('\u{1F6F0}\uFE0F Nexus Webhook Online.');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { token } = req.query;
    if (!token) {
      return res.status(200).json({ status: 'dud', reason: 'No token.' });
    }

    const { data: strategy, error: lookupError } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('webhook_token', token)
      .maybeSingle();

    if (lookupError || !strategy) {
      return res.status(200).json({ status: 'dud', reason: 'Invalid or expired token.' });
    }

    const { id: strategyId, tenant_id: tenantId, strategy: strategyName, asset, is_active, last_veto_time, parameters, execution_mode, active_thesis } = strategy;

    // PAUSE CHECK
    if (!is_active) {
      return res.status(200).json({ status: 'dud', reason: 'Strategy paused.' });
    }

    // COOLDOWN CHECK (last_veto_time — populated by sniper.js on each signal)
    const cooldownMinutes = parseInt(parameters?.veto_cooldown_minutes ?? 10, 10);
    if (last_veto_time && cooldownMinutes > 0) {
      const lastVetoMs = new Date(last_veto_time).getTime();
      const nextAllowed = lastVetoMs + cooldownMinutes * 60 * 1000;
      if (Date.now() < nextAllowed) {
        return res.status(200).json({
          status: 'dud',
          reason: 'Cooldown active.',
          cooldown_remaining_seconds: Math.ceil((nextAllowed - Date.now()) / 1000)
        });
      }
    }

    // 🟢 AM72 — INVISIBLE-FALLBACK GUARD. The row was found by token, so a NULL
    // execution_mode is a data-integrity fault, NOT a reason to silently trade PAPER.
    // Fail LOUD so the operator fixes the row; never default a real strategy to PAPER.
    if (!execution_mode) {
      const detail = `Webhook token trade resolved a strategy_config row with NO execution_mode — REFUSING to default to PAPER.\n**Tenant:** ${tenantId}\n**Asset:** ${asset}\n**Strategy:** ${strategyName}\n**Cause:** strategy_config.execution_mode is null (data-integrity fault).`;
      console.error(`[WEBHOOK config_not_found] ${detail}`);
      await sendDiscordAlert(tenantId, {
        title: `🚨 Webhook config_not_found — trade REFUSED: ${asset}`,
        description: detail,
        color: 15158332,
      });
      await logAgentActivity(tenantId, 'Webhook', asset, detail, 'CONFIG_NOT_FOUND');
      return res.status(200).json({
        status: 'config_not_found',
        reason: 'Strategy row has no execution_mode; refusing to default to PAPER.',
        asset,
        strategy_id: strategyName,
      });
    }

    // Update last_veto_time to start a new cooldown window
    await supabase
      .from('strategy_config')
      .update({ last_veto_time: new Date().toISOString() })
      .eq('id', strategyId);

    // Forward to Hermes agent on Render
    const signalPayload = {
      tenant_id: tenantId,
      asset: req.body.symbol || asset,
      mode: 'ENTRY',
      strategy_id: strategyName,
      execution_mode,
      message: `Webhook signal received for ${strategyName} on ${asset}. ${JSON.stringify(req.body)}`,
      openTrade: null,
      previous_thesis: active_thesis || '',
      candles: [],
      indicators: {},
      macro_tf: parameters?.macro_tf || 'ONE_HOUR',
      trigger_tf: parameters?.trigger_tf || 'FIVE_MINUTE',
      qty: parameters?.qty || 1
    };

    fetch(HERMES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signalPayload)
    }).catch(e => console.error('[WEBHOOK] Hermes ping failed:', e.message));

    return res.status(200).json({
      status: 'forwarded',
      strategy: strategyName,
      asset,
      note: 'Signal forwarded to Nexus AI for evaluation.'
    });

  } catch (err) {
    console.error('[WEBHOOK FAULT]:', err.message);
    return res.status(200).json({ status: 'error', error: 'Internal error.' });
  }
}
