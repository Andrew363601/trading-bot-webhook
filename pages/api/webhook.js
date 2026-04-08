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
      
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('is_active', true)
        .single();

      if (configErr) throw new Error("Could not determine execution mode.");

      const currentMode = config.execution_mode || "PAPER";
      const isLive = currentMode === 'LIVE';

      if (isLive) {
        console.log(`[WEBHOOK] 🔴 LIVE TRADING.`);
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const executeUrl = `${protocol}://${host}/api/execute-trade`;

        fetch(executeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }).catch(e => console.error("[ROUTING FAULT]", e));
      }

      // Log the trade including the EXECUTION MODE
      const { error: insertErr } = await supabase.from('trade_logs').insert([{
        symbol: data.symbol || "DOGEUSDT",
        side: data.side || "LONG",
        pnl: parseFloat(data.pnl) || 0,
        entry_price: parseFloat(data.price || data.entry_price),
        mci_at_entry: parseFloat(data.mci || data.mci_at_entry),
        execution_mode: currentMode, // NEW: Log the mode
        exit_time: new Date().toISOString()
      }]);

      if (insertErr) throw insertErr;
      return res.status(200).json({ status: "success", mode: currentMode });

    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}