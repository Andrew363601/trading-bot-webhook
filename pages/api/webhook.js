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
      
      // Handle TradingView's string format if it arrives as a prefix
      if (typeof data === 'string' && data.startsWith('LOG_TRADE:')) {
        data = JSON.parse(data.replace('LOG_TRADE:', ''));
      }

      console.log("[WEBHOOK] Processing Trade Log:", data.symbol);

      // Insert into trade_logs
      const { error } = await supabase.from('trade_logs').insert([{
        symbol: data.symbol || "DOGEUSDT",
        side: data.side || "LONG",
        pnl: parseFloat(data.pnl) || 0,
        entry_price: parseFloat(data.entry_price),
        exit_price: parseFloat(data.exit_price),
        mci_at_entry: parseFloat(data.mci_at_entry),
        snr_score_at_entry: parseFloat(data.snr_score_at_entry),
        exit_time: data.exit_time ? new Date(data.exit_time).toISOString() : new Date().toISOString()
      }]);

      if (error) throw error;
      return res.status(200).json({ status: "success" });
    } catch (err) {
      console.error("[WEBHOOK] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
}