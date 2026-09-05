// pages/api/public-profile.js
// Authed endpoint for tenants to get and update their public profile (opt_in, alias).

import crypto from 'crypto';
import { verifyTenantContext } from '../../lib/auth-middleware';

export default async function handler(req, res) {
  let tenantContext;
  try {
    tenantContext = await verifyTenantContext(req);
  } catch (err) {
    return res.status(401).json({ error: err.message || 'Unauthorized' });
  }

  const { tenantId, supabase } = tenantContext;

  if (req.method === 'GET') {
    try {
      const { data: profile, error } = await supabase
        .from('public_profiles')
        .select('opt_in, alias')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (error) {
        console.error('[PUBLIC_PROFILE_GET] Error:', error);
        return res.status(500).json({ error: 'Failed to fetch public profile' });
      }

      const defaultAlias = `NX-${crypto.createHash('sha256').update(tenantId).digest('hex').substring(0, 4).toUpperCase()}`;

      return res.status(200).json({
        optIn: profile ? Boolean(profile.opt_in) : true,
        alias: profile?.alias || defaultAlias
      });
    } catch (err) {
      console.error('[PUBLIC_PROFILE_GET] Unexpected error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
      }

      const opt_in = Boolean(body?.opt_in);
      let alias = body?.alias ? String(body.alias).trim() : null;

      // Alias generation if not provided
      if (!alias) {
        alias = `NX-${crypto.createHash('sha256').update(tenantId).digest('hex').substring(0, 4).toUpperCase()}`;
      } else {
        // Validation: reject if length > 16 or contains invalid chars (allowed: a-zA-Z0-9_-)
        if (alias.length > 16 || /[^a-zA-Z0-9_-]/.test(alias)) {
          return res.status(400).json({
            error: 'Alias must be between 1 and 16 characters and contain only alphanumeric characters, underscores, or hyphens.'
          });
        }
      }

      // Check collision with other tenants
      const { data: collision, error: colErr } = await supabase
        .from('public_profiles')
        .select('tenant_id')
        .eq('alias', alias)
        .neq('tenant_id', tenantId)
        .maybeSingle();

      if (colErr) {
        console.error('[PUBLIC_PROFILE_POST] Collision check error:', colErr);
        return res.status(500).json({ error: 'Failed to validate alias' });
      }

      if (collision) {
        return res.status(409).json({ error: 'Alias is already taken by another user.' });
      }

      // Upsert profile
      const { data: updated, error: upsertErr } = await supabase
        .from('public_profiles')
        .upsert(
          {
            tenant_id: tenantId,
            alias,
            opt_in,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'tenant_id' }
        )
        .select('opt_in, alias')
        .single();

      if (upsertErr) {
        console.error('[PUBLIC_PROFILE_POST] Upsert error:', upsertErr);
        return res.status(500).json({ error: 'Failed to save public profile' });
      }

      return res.status(200).json({
        optIn: updated.opt_in,
        alias: updated.alias
      });
    } catch (err) {
      console.error('[PUBLIC_PROFILE_POST] Unexpected error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
