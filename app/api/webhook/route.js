import { createClient } from "@supabase/supabase-js";

// 🔐 Environment Variables — must be defined before functions use them
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET() {
  return new Response("👋 Webhook is working!", { status: 200 });
}

export async function POST(request) {
  try {
    const body = await request.json();
    console.log("📩 Webhook Received:", body);

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
      console.error("❌ Supabase Error:", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "✅ Stored in Supabase" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Handler Crash:", err.message);
    return new Response(JSON.stringify({ error: "Something broke" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
