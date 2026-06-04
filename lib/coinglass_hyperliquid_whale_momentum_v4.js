export async function coinglass_hyperliquid_whale_momentum_v4(symbol) {
    // Market Context: Institutional Coattail Momentum [1, 25, 33]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/hyperliquid/whale-alert?symbol=${symbol}&exchange=Hyperliquid`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const net_whale_flow = data.data.reduce((sum, d) => sum + (d.buyVol - d.sellVol), 0); // [25]
        return { status: "success", net_whale_flow };
    } catch (e) { return { status: "error", message: e.message }; }
}