export async function coinglass_orderbook_depth_imbalance_v4(symbol) {
    // Market Context: Microstructure Scalping, Ranging [13, 17]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/orderbook/ask-bids-history?symbol=${symbol}&depth=1.0`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const bid_sum = data.data.bids.reduce((sum, b) => sum + b.qty, 0);
        const ask_sum = data.data.asks.reduce((sum, a) => sum + a.qty, 0);
        
        const obi = (bid_sum - ask_sum) / (bid_sum + ask_sum); // [17]
        return { status: "success", obi };
    } catch (e) { return { status: "error", message: e.message }; }
}