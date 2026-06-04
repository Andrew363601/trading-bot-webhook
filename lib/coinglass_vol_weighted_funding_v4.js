export async function coinglass_vol_weighted_funding_v4(symbol) {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [9, 10]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/futures/funding-rate/vol-weighted?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const total_vol = data.data.reduce((sum, ex) => sum + ex.volume, 0);
        const fr_vol = data.data.reduce((sum, ex) => sum + (ex.fundingRate * (ex.volume / total_vol)), 0); // [9]
        
        return { status: "success", fr_vol };
    } catch (e) { return { status: "error", message: e.message }; }
}