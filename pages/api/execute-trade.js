// pages/api/execute-trade.js
import { createClient } from '@supabase/supabase-js';
import ccxt from 'ccxt';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const data = req.body; 
        const mode = data.execution_mode || 'PAPER';
        const isTestnet = mode === 'PAPER';

        // 1. Select the correct API Keys based on the Dashboard Mode
        const BYBIT_API_KEY = isTestnet ? process.env.BYBIT_API_KEY_DEMO : process.env.BYBIT_API_KEY_MAIN;
        const BYBIT_SECRET = isTestnet ? process.env.BYBIT_SECRET_DEMO : process.env.BYBIT_SECRET_MAIN; 

        if (!BYBIT_API_KEY || !BYBIT_SECRET) {
            throw new Error(`Bybit API keys missing for ${mode} mode. Check Vercel variables.`);
        }

        // 2. Clean and Format the Symbol for CCXT Futures ("DOGE/USDT:USDT")
        let rawSymbol = data.symbol || 'DOGEUSDT';
        rawSymbol = rawSymbol.replace('BYBIT:', '').replace('.P', '');
        const ccxtSymbol = rawSymbol.replace('USDT', '/USDT:USDT');

        const side = data.side?.toLowerCase() === 'long' || data.side?.toLowerCase() === 'buy' ? 'buy' : 'sell';
        const qty = data.qty || 100; // Hardcoded test quantity for now

        // 3. Initialize CCXT
        const exchange = new ccxt.bybit({
            apiKey: BYBIT_API_KEY,
            secret: BYBIT_SECRET,
            options: { defaultType: 'future' },
        });

        // Toggle CCXT Sandbox Mode if Dashboard is set to PAPER
        if (isTestnet) {
            exchange.setSandboxMode(true);
        }

        console.log(`[EXECUTE] Mode: ${mode} | Attempting ${side.toUpperCase()} ${qty} ${ccxtSymbol}`);

        // 4. Fire the Trade
        const orderResult = await exchange.createMarketOrder(ccxtSymbol, side, qty);

        // 5. Log the actualized trade to Supabase
        await supabase.from('trade_logs').insert([{
            symbol: rawSymbol,
            side: side.toUpperCase(),
            entry_price: orderResult.average || data.price,
            pnl: 0,
            mci_at_entry: data.mci || 0,
            execution_mode: mode,
            exit_time: new Date().toISOString()
        }]);

        return res.status(200).json({ 
            message: `Success: ${side.toUpperCase()} ${qty} ${ccxtSymbol} (${mode})`,
            order: orderResult.id
        });

    } catch (err) {
        console.error('[EXECUTE FAULT]:', err.message);
        return res.status(500).json({ error: err.message });
    }
}