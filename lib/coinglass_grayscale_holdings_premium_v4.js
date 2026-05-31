export async function coinglass_grayscale_holdings_premium_v4(asset = 'BTC') {
    // Market Context: Institutional Premium Arbitrage, Flow Divergence [1, 22, 26]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/grayscale/holdings-list?asset=${asset}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current = data.data[data.data.length - 1];
        const past_7d = data.data[data.data.length - 8];
        
        const premium = ((current.marketPrice - current.navPrice) / current.navPrice) * 100; // [26]
        const delta_holdings_7d = current.holdings - past_7d.holdings; // [26]
        
        return { status: "success", premium, delta_holdings_7d };
    } catch (e) { return { status: "error", message: e.message }; }
}