export async function coinglass_aggregated_liquidation_map_v4(symbol, range_percent = 1.5) {
    // Market Context: Liquidity Hunt, Sweep of Lows/Highs [14, 35]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/liquidation/aggregated-map?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        // Integration Logic mapped to density [14]
        const current_price = data.data.currentPrice;
        let high_density_pools = data.data.pools.filter(p => Math.abs((p.price - current_price)/current_price) <= (range_percent/100));
        
        return { status: "success", high_density_pools };
    } catch (e) { return { status: "error", message: e.message }; }
}