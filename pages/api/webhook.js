import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { symbol, side, price, strategy, version } = req.body;

      const { error } = await supabase.from("alerts").insert([
        {
          symbol,
          side,
          price,
          strategy,
          version,
          raw: req.body
        }
      ]);

      if (error) {
        console.error("❌ Supabase Insert Error:", error.message);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ message: "✅ Stored in Supabase" });

    } catch (err) {
      console.error("❌ Handler Crash:", err.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  if (req.method === 'GET') {
    return res.status(200).send("👋 Webhook is working!");
  }

  return res.status(405).send("Method Not Allowed");
}
