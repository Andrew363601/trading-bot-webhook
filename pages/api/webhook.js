import { createClient } from "@supabase/supabase-js";

// Setup Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { symbol, side, price } = req.body;

      const { error } = await supabase.from("alerts").insert([
        {
          symbol,
          side,
          price,
          raw: req.body,
        },
      ]);

      if (error) {
        console.error("❌ Supabase Error:", error.message);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ message: "✅ Stored in Supabase" });

    } catch (err) {
      console.error("❌ Handler Crash:", err.message);
      return res.status(500).json({ error: "Something broke" });
    }

  } else if (req.method === 'GET') {
    return res.status(200).send("👋 Webhook is working!");
  } else {
    return res.status(405).send("Method Not Allowed");
  }
}
