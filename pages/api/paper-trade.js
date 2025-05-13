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
    // 1. Get the most recent alert that has valid data
    const { data: alerts, error } = await supabase
      .from('alerts')
      .select('*')
      .not('symbol', 'is', null)
      .not('price', 'is', null)
      .not('side', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(1);

    if (error || alerts.length === 0) {
      return res.status(500).json({ error: "No valid alerts to process", detail: error });
    }

    const alert = alerts[0];

    // 2. Simulate execution
    const entryPrice = alert.price;
    const status = "executed";

    // 3. Insert into executions with strategy metadata
    const { error: insertError } = await supabase.from('executions').insert([
      {
        alert_id: alert.id,
        symbol: alert.symbol,
        side: alert.side,
        entry_price: entryPrice,
        strategy: alert.strategy,
        version: alert.version,
        status,
        notes: "Simulated paper trade based on strategy metadata"
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
