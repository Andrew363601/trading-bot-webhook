// lib/cleanup-scan-results.js
// Server-side utility to auto-delete scan_results older than 72 hours.
// Uses SUPABASE_SERVICE_ROLE_KEY — never exposed to public routes.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Deletes all rows from scan_results where created_at is older than 72 hours.
 * Safe to call repeatedly — no-op if nothing to delete.
 */
export async function cleanupOldScanResults() {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

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