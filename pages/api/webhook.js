import { createClient } from '@supabase/supabase-js';

// Initialize with Service Role Key for write access
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send("🛰️ Webhook Online.");

  if (req.method === 'POST') {
    try {
      let data = req.body;
      
      // Clean stringified payloads if necessary
      if (typeof data === 'string' && data.startsWith('LOG_TRADE:')) {
        data = JSON.parse(data.replace('LOG_TRADE:', ''));
      }

      console.log(`[WEBHOOK] Signal Received for ${data.symbol || 'DOGEUSDT'}`);

      // 1. Check Execution Mode
      const { data: config, error: configErr } = await supabase
        .from('strategy_config')
        .select('execution_mode')
        .eq('is_active', true)
        .single();

      if (configErr) throw new Error("Could not determine execution mode.");

      const isLive = config.execution_mode === 'LIVE';

      // 2. Route the Signal (Live Trading)
      if (isLive) {
        console.log(`[WEBHOOK] 🔴 LIVE TRADING ACTIVE. Routing to Bybit Execute API.`);
        
        // Construct the internal URL to forward the request
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const executeUrl = `${protocol}://${host}/api/execute-trade`;

        // Fire and forget: We don't await this so TradingView gets a fast 200 OK response
        fetch(executeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }).catch(e => console.error("[ROUTING FAULT]", e));

        return res.status(200).json({ status: "success", mode: "LIVE", action: "Routed to Bybit" });
      }

      // 3. Paper Trading Fallback (Logging only)
      console.log(`[WEBHOOK] 🟢 PAPER TRADING. Logging simulation to database.`);
      
      const { error: insertErr } = await supabase.from('trade_logs').insert([{
        symbol: data.symbol || "DOGEUSDT",
        side: data.side || "LONG",
        pnl: parseFloat(data.pnl) || 0,
        entry_price: parseFloat(data.price || data.entry_price),
        mci_at_entry: parseFloat(data.mci || data.mci_at_entry),
        exit_time: new Date().toISOString()
      }]);

      if (insertErr) throw insertErr;
      return res.status(200).json({ status: "success", mode: "PAPER", action: "Logged locally" });

    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}