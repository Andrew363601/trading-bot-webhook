// lib/cleanup-agent-logs.js
// Server-side utility to auto-delete agent_session_logs older than 24 hours.
// Mirrors the cleanup-scan-results.js pattern with shorter retention.
// Uses SUPABASE_SERVICE_ROLE_KEY — never exposed to public routes.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Deletes all rows from agent_session_logs where created_at is older than 24 hours.
 * Safe to call repeatedly — no-op if nothing to delete.
 */
export async function cleanupOldAgentLogs() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('agent_session_logs')
      .delete()
      .lt('created_at', cutoff);

    if (error) {
      console.error('[CLEANUP] Failed to delete old agent_session_logs:', error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(`[CLEANUP] Deleted ${data.length} old agent_session_logs rows (before ${cutoff}).`);
    }
  } catch (err) {
    console.error('[CLEANUP] Fatal error in cleanupOldAgentLogs:', err.message);
  }
}