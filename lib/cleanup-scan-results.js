// lib/cleanup-scan-results.js
// Server-side utility to auto-delete scan_results older than 72 hours.
// Uses SUPABASE_SERVICE_ROLE_KEY — never exposed to public routes.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Deletes all rows from scan_results where created_at is older than 72 hours,
 * along with their agent_tool_calls (scan_id REFERENCES scan_results(id) with
 * no ON DELETE — FK violation otherwise). Tool calls older than retention are
 * outside every training/timeline window (all consumers filter gte(created_at,
 * since), and since ≤ 72h), so deleting them here is safe.
 * Safe to call repeatedly — no-op if nothing to delete.
 */
export async function cleanupOldScanResults() {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

    // 🟢 AM2e — FK order: agent_tool_calls.scan_id → scan_results(id) has no
    // ON DELETE action, so the referencing rows MUST go first.
    const { data: tcData, error: tcErr } = await supabase
      .from('agent_tool_calls')
      .delete()
      .lt('created_at', cutoff);

    if (tcErr) {
      console.error('[CLEANUP] Failed to delete old agent_tool_calls:', tcErr.message);
      return;
    }
    if (tcData && tcData.length > 0) {
      console.log(`[CLEANUP] Deleted ${tcData.length} old agent_tool_calls rows (before ${cutoff}).`);
    }

    const { data, error } = await supabase
      .from('scan_results')
      .delete()
      .lt('created_at', cutoff);

    if (error) {
      console.error('[CLEANUP] Failed to delete old scan_results:', error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(`[CLEANUP] Deleted ${data.length} old scan_results rows (before ${cutoff}).`);
    }
  } catch (err) {
    console.error('[CLEANUP] Fatal error in cleanupOldScanResults:', err.message);
  }
}