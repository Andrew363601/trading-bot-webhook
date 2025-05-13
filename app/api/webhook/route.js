import { createClient } from "@supabase/supabase-js";

// 🔐 Environment Variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request) {
  try {
    const body = await request.json();
    console.log("📩 TradingView Webhook Received:", body);

    const { symbol, side, price } = body;

    const { error } = await supabase.from("alerts").insert([
      {
        symbol,
        side,
        price,
        raw: body,
      },
    ]);

    if (error) {
      console.error("❌ Supabase Insert Error:", error);
      return new Response(JSON.stringify({ status: "error", error }), { status: 500 });
    }

    return new Response(JSON.stringify({ status: "Stored in Supabase ✅" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Webhook Handler Error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
