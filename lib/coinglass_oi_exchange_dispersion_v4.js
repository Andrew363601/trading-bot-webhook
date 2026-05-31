export async function coinglass_oi_exchange_dispersion_v4(symbol) {
    // Market Context: Ranging, Cross-Exchange Arbitrage [4, 9]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/open-interest/exchange-list?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const total_oi = data.data.reduce((sum, ex) => sum + ex.oi, 0);
        
        // HHI Math [4]
        const hhi_oi = data.data.reduce((sum, ex) => sum + Math.pow((ex.oi / total_oi), 2), 0);
        const largest_exchange = data.data.sort((a, b) => b.oi - a.oi);
        
        return { status: "success", hhi_oi, top_exchange: largest_exchange.exchangeName };
    } catch (e) { return { status: "error", message: e.message }; }
}