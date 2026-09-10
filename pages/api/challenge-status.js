// pages/api/challenge-status.js
// 100K Simulation Challenge — status endpoint.
// Public aggregates always returned; personal section included when a valid
// bearer token is present (auth optional — verifyTenantContext degrades gracefully).

import { verifyTenantContext } from '../../lib/auth-middleware';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Public aggregates
    const { data: entries, error: entriesErr } = await supabase
      .from('challenge_entries')
      .select('window_start, window_end')
      .eq('status', 'active');

    if (entriesErr) {
      console.error('[CHALLENGE_STATUS] Entries query error:', entriesErr);
      return res.status(500).json({ error: 'Failed to fetch challenge data' });
    }

    const first = (entries || [])[0];
    const windowStart = first?.window_start || '2026-09-11T00:00:00Z';
    const windowEnd =
      first?.window_end ||
      new Date(new Date(windowStart).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const payload = {
      total_entries: (entries || []).length,
      window_start: windowStart,
      window_end: windowEnd
    };

    // Optional personal section
    try {
      const ctx = await verifyTenantContext(req);
      const { data: entry } = await supabase
        .from('challenge_entries')
        .select('alias, window_start, window_end, status, start_equity, joined_at')
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (entry) {
        const end = new Date(entry.window_end).getTime();
        payload.entered = true;
        payload.alias = entry.alias;
        payload.status = entry.status;
        payload.start_equity = Number(entry.start_equity);
        payload.joined_at = entry.joined_at;
        payload.days_remaining = Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));
        payload.window_start = entry.window_start;
        payload.window_end = entry.window_end;
      } else {
        payload.entered = false;
      }
    } catch {
      payload.entered = false; // not authed — public view only
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[CHALLENGE_STATUS] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
