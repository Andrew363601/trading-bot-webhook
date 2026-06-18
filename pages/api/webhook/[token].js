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
      execution_mode: execution_mode || 'PAPER',
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
