export async function coinglass_cross_exchange_funding_spread_v4(symbol) {
    // Market Context: Statistical Arbitrage, Structural Divergence [6, 9]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/futures/funding-rate/exchange-list?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const rates = data.data.map(ex => ex.fundingRate);
        const spread_fr = Math.max(...rates) - Math.min(...rates); // [6]
        
        return { status: "success", spread_fr, max_rate: Math.max(...rates), min_rate: Math.min(...rates) };
    } catch (e) { return { status: "error", message: e.message }; }
}