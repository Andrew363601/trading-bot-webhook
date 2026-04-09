import { Coinbase, RESTClient } from "@coinbase/coinbase-sdk";
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const data = req.body;
    const mode = data.execution_mode || 'PAPER';
    const isPaper = mode === 'PAPER';

    // 1. Initialize Coinbase Client
    // Ensure COINBASE_API_KEY is the "organizations/.../apiKeys/..." string
    // Ensure COINBASE_API_SECRET is the full "---BEGIN EC PRIVATE KEY---" block
    const client = new RESTClient(
      process.env.COINBASE_API_KEY,
      process.env.COINBASE_API_SECRET
    );

    // 2. Format Asset String (e.g., "DOGE-USDT")
    let rawSymbol = data.symbol || 'DOGEUSDT';
    rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '');
    const coinbaseProduct = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');

    const side = (data.side || 'buy').toUpperCase() === 'LONG' || (data.side || 'buy').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const qty = data.qty?.toString() || "100";

    console.log(`[COINBASE ENGINE] Mode: ${mode} | Product: ${coinbaseProduct} | Side: ${side}`);

    let executionResult = { status: 'simulated', price: data.price || 0 };

    if (!isPaper) {
      // LIVE EXECUTION
      const order = await client.createMarketOrder({
        productId: coinbaseProduct,
        side: side,
        baseSize: qty,
      });
      executionResult = { status: 'filled', price: order.average_filled_price || data.price };
    } else {
      // PAPER DRY-RUN: Fetch actual market price to ensure the simulation is realistic
      try {
        const product = await client.getProduct(coinbaseProduct);
        executionResult.price = parseFloat(product.price);
      } catch (e) {
        console.warn("[PAPER] Could not fetch live price, using alert price.");
      }
    }

    // 3. Log to Supabase trade_logs
    const { error: logError } = await supabase.from('trade_logs').insert([{
      symbol: rawSymbol,
      side: side,
      entry_price: executionResult.price,
      execution_mode: mode,
      pnl: 0,
      mci_at_entry: data.mci || 0,
      exit_time: new Date().toISOString()
    }]);

    if (logError) throw logError;

    return res.status(200).json({
      status: "success",
      mode,
      product: coinbaseProduct,
      executed_price: executionResult.price
    });

  } catch (err) {
    console.error("[COINBASE ENGINE FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}