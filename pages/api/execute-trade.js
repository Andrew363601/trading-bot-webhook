// pages/api/execute-trade.js
import { Coinbase } from 'coinbase-advanced-node';
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

    // 1. Fetch Keys
    const apiKeyName = process.env.COINBASE_API_KEY;
    let apiSecret = process.env.COINBASE_API_SECRET;

    if (!apiKeyName || !apiSecret) {
      throw new Error("Missing Coinbase API credentials in environment.");
    }

    // 2. Initialize the Correct Advanced Trade Client
    const client = new Coinbase({
        cloudApiKeyName: apiKeyName,
        cloudApiSecret: apiSecret.replace(/\\n/g, '\n') // Fixes copy-paste newline errors
    });

    // 3. Format Symbol (DOGEUSDT -> DOGE-USDT)
    let rawSymbol = data.symbol || 'DOGEUSDT';
    rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '');
    const coinbaseProduct = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');

    const side = (data.side || 'BUY').toUpperCase() === 'LONG' || (data.side || 'BUY').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const qty = (data.qty || 100).toString();

    console.log(`[COINBASE ENGINE] Processing ${side} for ${coinbaseProduct} (${mode})`);

    let executionPrice = data.price || 0;

    // 4. Execution Logic
    if (!isPaper) {
      // LIVE TRADE (Spot)
      const order = await client.rest.order.placeOrder({
        clientOrderId: `nexus_${Date.now()}`,
        productId: coinbaseProduct,
        side: side,
        orderConfiguration: {
          marketMarketIoc: {
            baseSize: qty,
          }
        }
      });
      // Fallback depending on exact API payload shape
      executionPrice = order?.success_response?.average_price || data.price; 
    } else {
      // PAPER DRY-RUN: Fetch live price to verify API Keys are valid
      const response = await client.rest.product.getProduct(coinbaseProduct);
      // Ensure we grab the price regardless of payload nesting
      executionPrice = parseFloat(response?.price || response?.product?.price || data.price);
      console.log(`[PAPER] Verified live price: $${executionPrice}`);
    }

    // 5. Log to Supabase
    const { error: logError } = await supabase.from('trade_logs').insert([{
      symbol: rawSymbol,
      side: side,
      entry_price: executionPrice,
      execution_mode: mode,
      pnl: 0,
      mci_at_entry: data.mci || 0,
      exit_time: new Date().toISOString()
    }]);

    if (logError) throw new Error(`Supabase Log Error: ${logError.message}`);

    return res.status(200).json({ 
      status: "executed", 
      product: coinbaseProduct, 
      price: executionPrice 
    });

  } catch (err) {
    console.error("[EXECUTE FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}