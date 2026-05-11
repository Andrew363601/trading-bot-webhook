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
      const { tenant_id } = req.query; // Support multi-tenant isolation via query param

      if (!tenant_id) {
        console.error("[WEBHOOK ERROR]: Missing tenant_id in request query.");
        return res.status(400).json({ error: "Missing tenant_id in query parameters." });
      }

      // 1. Determine Mode from Dashboard for specific tenant
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('tenant_id', tenant_id)
        .eq('is_active', true)
        .single();

      if (configErr && configErr.code !== 'PGRST116') {
          console.error("[WEBHOOK ERROR]: Could not fetch execution mode:", configErr.message);
          throw new Error("Could not fetch execution mode.");
      }

      const mode = config?.execution_mode || "PAPER";
      data.execution_mode = mode; 
      data.tenant_id = tenant_id; // Pass tenant_id to the engine

      // 2. Route to Coinbase Engine
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;
      const executeUrl = `${protocol}://${host}/api/execute-trade`;

      console.log(`[ROUTER] Forwarding ${data.symbol} to Engine for tenant ${tenant_id} in ${mode} mode...`);

      // 🟢 THE FIX: Pass Service Role Key for internal authentication
      const forwardRequest = await fetch(executeUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
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