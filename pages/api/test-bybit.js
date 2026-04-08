import ccxt from 'ccxt';

export default async function handler(req, res) {
    let apiKey = "NOT_FOUND";
    try {
        apiKey = process.env.BYBIT_API_KEY_DEMO;
        const secret = process.env.BYBIT_SECRET_DEMO;

        if (!apiKey || !secret) {
            return res.status(400).json({ error: "Missing BYBIT_API_KEY_DEMO or BYBIT_SECRET_DEMO in Vercel/env" });
        }

        // The Magic Fix: .trim() instantly deletes any accidental blank spaces from copy/pasting
        const cleanApiKey = apiKey.trim();
        const cleanSecret = secret.trim();

        const exchange = new ccxt.bybit({
            apiKey: cleanApiKey,
            secret: cleanSecret,
            options: { defaultType: 'future' }
        });

        // FORCE Bybit Testnet 
        exchange.setSandboxMode(true);

        const balance = await exchange.fetchBalance();

        return res.status(200).json({
            message: "🟢 BYBIT TESTNET CONNECTION SUCCESSFUL!",
            key_used: cleanApiKey.substring(0, 5) + "...",
            usdt_balance: balance.USDT?.free || 0
        });

    } catch (err) {
        return res.status(500).json({
            error: "🔴 BYBIT REJECTED THE CONNECTION",
            key_vercel_is_actually_trying_to_use: apiKey ? apiKey.substring(0, 5) + "..." : "UNDEFINED",
            details: err.message
        });
    }
}