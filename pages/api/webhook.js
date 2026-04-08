// pages/api/webhook.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send("🛰️ Webhook Online.");

  if (req.method === 'POST') {
    try {
      let data = req.body;
      if (typeof data === 'string' && data.startsWith('LOG_TRADE:')) {
        data = JSON.parse(data.replace('LOG_TRADE:', ''));
      }

      // 1. Read the toggle state from your Dashboard
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('is_active', true)
        .single();

      if (configErr) throw new Error("Could not determine execution mode.");

      // 2. Attach the mode to the signal
      const mode = config.execution_mode || "PAPER";
      data.execution_mode = mode; 

      // 3. Forward EVERYTHING to the Execution Engine
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;
      const executeUrl = `${protocol}://${host}/api/execute-trade`;

      // Fire and forget so TradingView doesn't time out
      fetch(executeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(e => console.error("[ROUTING FAULT]", e));

      return res.status(200).json({ status: "success", mode: mode, action: "Routed to Execution Engine" });

    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}