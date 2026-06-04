export async function coinglass_aggregated_orderbook_depth_v4(symbol) {
    // Market Context: Institutional Liquidity Sourcing [12, 18]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/futures/orderbook/aggregated?symbol=${symbol}&depth=0.5`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const bid_sum = data.data.bids.reduce((sum, b) => sum + b.qty, 0);
        const ask_sum = data.data.asks.reduce((sum, a) => sum + a.qty, 0);
        
        const agg_depth_imbalance = (bid_sum - ask_sum) / (bid_sum + ask_sum); // [18]
        return { status: "success", agg_depth_imbalance };
    } catch (e) { return { status: "error", message: e.message }; }
}