// app/api/webhook/route.js
export async function POST(request) {
  const body = await request.json();

  console.log("📩 TradingView Webhook Received:", body);

  // Optionally log to a database or trigger something here
  return new Response(JSON.stringify({ status: "Received ✅" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
