import ccxt from 'ccxt';

export default async function handler(req, res) {
    try {
        const apiKey = process.env.BYBIT_API_KEY_DEMO;
        const secret = process.env.BYBIT_SECRET_DEMO;

        if (!apiKey || !secret) {
            return res.status(400).json({ error: "Missing BYBIT_API_KEY_DEMO or BYBIT_SECRET_DEMO in Vercel/env" });
        }

        const exchange = new ccxt.bybit({
            apiKey: apiKey,
            secret: secret,
            options: { defaultType: 'future' }
        });

        // FORCE Bybit Testnet (This is the crucial step)
        exchange.setSandboxMode(true);

        // Fetch balance (Doesn't place a trade, just proves the keys are valid)
        const balance = await exchange.fetchBalance();

        return res.status(200).json({
            message: "🟢 BYBIT TESTNET CONNECTION SUCCESSFUL!",
            key_used: apiKey.substring(0, 5) + "...",
            usdt_balance: balance.USDT?.free || 0
        });

    } catch (err) {
        return res.status(500).json({
            error: "🔴 BYBIT REJECTED THE CONNECTION",
            details: err.message
        });
    }
}