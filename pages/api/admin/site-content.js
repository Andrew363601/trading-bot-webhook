// pages/api/admin/site-content.js
// Protected API route for the admin page to save landing-page content.
// Auth: Bearer token verified via supabase.auth.getUser() — same pattern
// as pages/api/close-position.js.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { section_key, content } = req.body;
  if (!section_key || content === undefined) {
    return res.status(400).json({ error: 'Missing section_key or content' });
  }

  // --- Auth: Bearer token (same pattern as close-position.js) ---
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization' });
  }

  const token = authHeader.substring(7);

  try {
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Confirm the user is linked to a tenant (must be a real user)
    const { data: tenantLink, error: tenantError } = await supabaseAdmin
      .from('tenant_users')
      .select('tenant_id')
      .eq('auth_user_id', user.id)
      .single();

    if (tenantError || !tenantLink) {
      return res.status(401).json({ error: 'User not linked to a tenant' });
    }
  } catch (authErr) {
    return res.status(401).json({ error: 'Token verification failed' });
  }

  // --- Upsert content ---
  const { error } = await supabaseAdmin
    .from('site_content')
    .upsert(
      {
        section_key,
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'section_key' }
    );

  if (error) {
    console.error('[ADMIN] Upsert failed:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ success: true });
}