// pages/api/webhook.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send("🛰️ Nexus Webhook Online.");

  if (req.method === 'POST') {
    try {
      let data = req.body;

      // 1. Determine Mode from Dashboard
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('is_active', true)
        .single();

      if (configErr) throw new Error("Could not fetch execution mode.");

      const mode = config?.execution_mode || "PAPER";
      data.execution_mode = mode; 

      // 2. Route to Coinbase Engine
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;
      const executeUrl = `${protocol}://${host}/api/execute-trade`;

      console.log(`[ROUTER] Forwarding ${data.symbol} to Engine in ${mode} mode...`);

      // CRITICAL: We MUST await this fetch so Vercel doesn't kill the process early
      const forwardRequest = await fetch(executeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const forwardResult = await forwardRequest.json();

      return res.status(200).json({ 
        status: "success", 
        mode: mode, 
        engine_response: forwardResult 
      });

    } catch (err) {
      console.error("[WEBHOOK FAULT]:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}