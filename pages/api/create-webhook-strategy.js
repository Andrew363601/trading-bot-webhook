// pages/api/create-webhook-strategy.js
// Creates a strategy_config row with a webhook token for TradingView.
// Returns the webhook URL and TradingView JSON payload template.
// Only supports Coinbase CDE futures (ready for immediate LIVE trading).

import { createClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  let tenantId;
  try {
    const token = authHeader.split(' ')[1];
    const { payload } = await jwtVerify(token, JWKS);
    const { data: userData } = await supabase
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', payload.sub)
      .single();
    if (!userData) throw new Error('Tenant not found');
    tenantId = userData.tenant_id;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { asset, strategy_name, execution_mode } = req.body;
  if (!asset || !strategy_name) {
    return res.status(400).json({ error: 'Missing asset or strategy_name' });
  }

  // Only crypto CDE futures supported (ready for LIVE trading on Coinbase)
  const CRYPTO_CDE_LABELS = { BIT: 'BTC', ETP: 'ETH', SLP: 'SOL', DOP: 'DOGE', LCP: 'LTC', AVP: 'AVAX', LNP: 'LINK', XPP: 'XRP', WLD: 'WLD' };
  
  let cdeCode = asset.toUpperCase();
  const readable = Object.entries(CRYPTO_CDE_LABELS).find(([code, label]) => cdeCode === label || cdeCode === code);
  
  if (!readable) {
    return res.status(400).json({ error: `Only CDE futures supported. Choose: ${Object.values(CRYPTO_CDE_LABELS).join(', ')}` });
  }
  
  cdeCode = readable[0];
  const displayName = CRYPTO_CDE_LABELS[cdeCode];
  const canonicalStrategy = strategy_name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

  try {
    const payload = {
      tenant_id: tenantId,
      strategy: canonicalStrategy,
      version: 'v1.0',
      asset: cdeCode,
      execution_mode: execution_mode || 'PAPER',
      is_active: true,
      parameters: {
        qty: 1,
        leverage: 1,
        macro_tf: 'ONE_HOUR',
        trigger_tf: 'FIVE_MINUTE',
        market_type: 'FUTURES',
        tripwire_percent: 0.0025,
        trail_step_percent: 0.001,
        veto_cooldown_minutes: 10
      },
      config: {
        exchange: 'COINBASE',
        product_type: 'FUTURES',
        source: 'webhook_creator'
      },
      last_updated: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('strategy_config')
      .upsert(payload, { onConflict: ['tenant_id', 'asset', 'strategy'] })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      strategy: data,
      webhook_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://nexustradingagent.com'}/api/webhook/${data.webhook_token}`,
      tradingview_payload_template: JSON.stringify({
        auth_token: data.webhook_token,
        strategy_tag: data.strategy,
        action: '{{strategy.order.action}}',
        price: '{{close}}',
        symbol: '{{ticker}}'
      }, null, 2)
    });
  } catch (e) {
    console.error('[CREATE WEBHOOK] Failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
