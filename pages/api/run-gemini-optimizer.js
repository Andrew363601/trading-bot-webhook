import { createClient } from '@supabase/supabase-js';

/**
 * R(ΨC) COMMIT ENGINE
 * ---------------------------------------------------------
 * Pure server-side logic to update the strategy configuration.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cronSecret = process.env.CRON_SECRET || "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

  // Auth Guard
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  const { parameters, version } = req.body;
  if (!parameters || !version) {
    return res.status(400).json({ error: "Invalid Request: Missing parameters or version key." });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { error: updateErr } = await supabase
      .from('strategy_config')
      .update({ 
        parameters, 
        version,
        last_updated: new Date().toISOString()
      })
      .eq('is_active', true);

    if (updateErr) throw updateErr;

    return res.status(200).json({ 
      message: `Resonance Shift Successful. Nexus updated to v${version}.` 
    });

  } catch (err) {
    console.error("[COMMIT FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}