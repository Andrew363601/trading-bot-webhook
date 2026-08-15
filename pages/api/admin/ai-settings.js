// pages/api/admin/ai-settings.js
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Auth: Bearer token verification
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  let user;
  try {
    const { data: { user: authUser }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !authUser) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }
    user = authUser;

    // Check if user's tenant has billing_tier === 'ADMIN' or role === 'ADMIN'
    const { data: tenantLink, error: linkError } = await supabaseAdmin
      .from('tenant_users')
      .select('tenant_id, role')
      .eq('auth_user_id', user.id)
      .single();

    if (linkError || !tenantLink) {
      return res.status(401).json({ error: 'User not associated with a tenant' });
    }

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('billing_tier')
      .eq('id', tenantLink.tenant_id)
      .single();

    const isBillingAdmin = tenant?.billing_tier?.toUpperCase() === 'ADMIN';
    const isRoleAdmin = tenantLink?.role?.toUpperCase() === 'ADMIN';

    if (!isBillingAdmin && !isRoleAdmin) {
      return res.status(403).json({ error: 'Access denied: ADMIN privileges required' });
    }
  } catch (authErr) {
    return res.status(401).json({ error: `Auth verification failed: ${authErr.message}` });
  }

  // --- GET: Fetch current config & available OpenRouter models ---
  if (req.method === 'GET') {
    try {
      const { data: config } = await supabaseAdmin
        .from('app_config')
        .select('ai_provider, ai_model, updated_at')
        .eq('id', 1)
        .maybeSingle();

      const ai_provider = config?.ai_provider || 'gemini';
      const ai_model = config?.ai_model || 'gemini-3-flash-preview';

      let available_models = [];
      const openRouterKey = process.env.OPENROUTER_API_KEY;

      if (openRouterKey) {
        try {
          const orResp = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'HTTP-Referer': 'https://nexustradingagent.com',
              'X-Title': 'Nexus Trading'
            }
          });
          if (orResp.ok) {
            const orData = await orResp.json();
            available_models = (orData.data || []).map(m => ({
              id: m.id,
              name: m.name || m.id,
              context_length: m.context_length
            }));
          }
        } catch (fetchErr) {
          console.warn('[AI SETTINGS] Failed to fetch OpenRouter models:', fetchErr.message);
        }
      }

      return res.status(200).json({
        ai_provider,
        ai_model,
        available_models,
        env: {
          has_gemini_key: !!process.env.GEMINI_API_KEY,
          has_openrouter_key: !!openRouterKey
        }
      });
    } catch (err) {
      return res.status(500).json({ error: `Failed to retrieve AI settings: ${err.message}` });
    }
  }

  // --- POST /test: Test connection ---
  if (req.method === 'POST' && req.query.action === 'test') {
    const { ai_provider, ai_model } = req.body || {};
    try {
      if (ai_provider === 'openrouter') {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured on the server.');
        const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: ai_model || 'openai/gpt-4o-mini',
            messages: [{ role: 'user', content: 'Respond with "OK"' }],
            max_tokens: 10
          })
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          throw new Error(`OpenRouter error (${resp.status}): ${errBody}`);
        }
        return res.status(200).json({ success: true, message: 'OpenRouter connection verified!' });
      } else {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server.');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${ai_model || 'gemini-3-flash-preview'}:generateContent?key=${apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Respond with "OK"' }] }]
          })
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          throw new Error(`Gemini error (${resp.status}): ${errBody}`);
        }
        return res.status(200).json({ success: true, message: 'Gemini connection verified!' });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  // --- PUT: Save new AI provider/model selection ---
  if (req.method === 'PUT') {
    const { ai_provider, ai_model } = req.body || {};

    if (!ai_provider || !['gemini', 'openrouter'].includes(ai_provider)) {
      return res.status(400).json({ error: 'Invalid ai_provider. Must be "gemini" or "openrouter".' });
    }
    if (!ai_model || typeof ai_model !== 'string' || !ai_model.trim()) {
      return res.status(400).json({ error: 'ai_model must be a non-empty string.' });
    }
    if (ai_provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
      return res.status(400).json({ error: 'Cannot activate OpenRouter: OPENROUTER_API_KEY is not set in environment.' });
    }

    try {
      const { error: upsertError } = await supabaseAdmin
        .from('app_config')
        .upsert({
          id: 1,
          ai_provider: ai_provider.trim(),
          ai_model: ai_model.trim(),
          updated_at: new Date().toISOString(),
          updated_by: user.id
        }, { onConflict: 'id' });

      if (upsertError) throw upsertError;

      return res.status(200).json({ success: true, ai_provider, ai_model });
    } catch (err) {
      return res.status(500).json({ error: `Failed to update AI settings: ${err.message}` });
    }
  }
}
