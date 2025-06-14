// api/execute-trade.js
// This function receives trade signals from TradingView alerts and executes them on Bybit Futures.

import { createClient } from '@supabase/supabase-js';
import ccxt from 'ccxt'; // Import the ccxt library

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const tradeSignal = req.body; // This is the JSON payload from your Pine Script alert
        const { 
            symbol, // e.g., "DOGE/USDT" (ccxt format)
            side,   // "long" or "short"
            qty,    // quantity of base asset (e.g., DOGE)
            order_type, // e.g., "market"
            leverage,
            is_testnet, // boolean flag from Pine Script
            strategy, // "CCA_v1"
            version,  // "v1.0"
            alert_price // Price at which alert fired (for logging)
        } = tradeSignal;

        // --- 1. Get Bybit API Keys based on Testnet/Mainnet ---
        const BYBIT_API_KEY = is_testnet ? process.env.BYBIT_API_KEY_DEMO : process.env.BYBIT_API_KEY_MAIN;
        const BYBIT_SECRET = is_testnet ? process.env.BYBIT_SECRET_DEMO : process.env.BYBIT_SECRET_MAIN;

        if (!BYBIT_API_KEY || !BYBIT_SECRET) {
            console.error('Bybit API keys are not set in environment variables for selected mode (Testnet/Mainnet).');
            return res.status(500).json({ error: 'Bybit API keys not configured for selected mode.' });
        }
        if (!symbol || !side || !qty || !order_type || !leverage) {
            return res.status(400).json({ error: 'Missing required trade parameters (symbol, side, qty, order_type, leverage).' });
        }

        // --- 2. Initialize Bybit Exchange API Client ---
        const exchange = new ccxt.bybit({
            apiKey: BYBIT_API_KEY,
            secret: BYBIT_SECRET,
            'options': {
                'defaultType': 'future', // Crucial for futures trading
                'adjustForTimeDifference': true, // Recommended
            },
            'enableRateLimit': true, // Recommended for production to avoid hitting rate limits
        });

        // Set testnet mode for Bybit if enabled
        if (is_testnet) {
            exchange.setSandboxMode(true);
        }

        let orderResult = null;
        let executionStatus = 'failed';
        let executionNotes = 'Order not placed (Exchange API call failed)';
        let executedPrice = null;
        let executedQty = null;

        try {
            // --- 3. Set Leverage and Margin Mode (for futures) ---
            // 'isolated' is commonly used. 'cross' is another option.
            const marginMode = 'isolated'; 
            await exchange.setLeverage(symbol, leverage, { 'marginMode': marginMode });
            console.log(`Leverage set to ${leverage} for ${symbol} with ${marginMode} margin.`);

            // --- 4. Place Order on Exchange ---
            // For simplicity, we'll assume 'market' orders from Pine Script
            const ccxtSide = side === 'long' ? 'buy' : 'sell'; // ccxt uses 'buy'/'sell'

            orderResult = await exchange.createOrder(
                symbol,       // e.g., 'DOGE/USDT'
                order_type,   // 'market'
                ccxtSide,     // 'buy' or 'sell'
                qty           // quantity in base asset (e.g., DOGE coins)
                // price,     // Only needed for 'limit' orders
            );
            
            executionStatus = orderResult.status === 'closed' || orderResult.status === 'filled' ? 'executed' : orderResult.status;
            executedPrice = orderResult.price || orderResult.average; // average is often filled price
            executedQty = orderResult.filled;
            executionNotes = `Order ID: ${orderResult.id}, Status: ${orderResult.status}, Cost: ${orderResult.cost}`;
            console.log('Order placed:', orderResult);

        } catch (exchangeError) {
            executionStatus = 'failed';
            executionNotes = `Exchange API error: ${exchangeError.message}`;
            console.error('Exchange API error during order placement or leverage setting:', exchangeError);
        }

        // --- 5. Log Execution to Supabase ---
        const { error: logError } = await supabase.from('executions').insert([
            {
                symbol: symbol,
                side: side,
                entry_price: alert_price, // Price at which alert fired from Pine Script
                executed_price: executedPrice, // The actual price the order filled at
                executed_qty: executedQty,
                strategy: strategy,
                version: version,
                status: executionStatus,
                notes: executionNotes,
                // Add more fields from orderResult if useful for debugging/analysis
            }
        ]);

        if (logError) {
            console.error('Supabase error logging execution:', logError.message);
            // This error is critical, but we might still want to return success if exchange trade succeeded.
        }

        return res.status(200).json({ 
            message: `Trade signal received for ${symbol}: ${side} ${qty}. Execution status: ${executionStatus}.`,
            order_result: orderResult 
        });

    } catch (err) {
        console.error('Execute Trade Handler Crash:', err.message);
        return res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
}
