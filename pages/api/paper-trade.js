import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // 1. Get the most recent alert (or customize how you select)
    const { data: alerts, error } = await supabase
      .from('alerts')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1);

    if (error || alerts.length === 0) {
      return res.status(500).json({ error: "No alerts to process", detail: error });
    }

    const alert = alerts[0];

    // 2. Simulate execution
    const entryPrice = alert.price;
    const status = "executed";
    const notes = "Paper trade executed at simulated entry price.";

    // 3. Insert into executions
    const { error: insertError } = await supabase.from('executions').insert([
      {
        alert_id: alert.id,
        symbol: alert.symbol,
        side: alert.side,
        entry_price: entryPrice,
        status,
        notes
      }
    ]);

    if (insertError) {
      throw insertError;
    }

    return res.status(200).json({ message: "✅ Paper trade executed", alert });

  } catch (err) {
    console.error("❌ Paper trade error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
