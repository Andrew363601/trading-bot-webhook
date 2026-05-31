export async function coinglass_spot_cvd_divergence_v4(symbol) {
    // Market Context: Structural Trend-Following, Reversal Detection [16, 33]
    try {
        const resSpot = await fetch(`https://open-api-v3.coinglass.com/api/spot/taker-buy-sell-volume/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const resFut = await fetch(`https://open-api-v3.coinglass.com/api/futures/taker-buy-sell-volume/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const spotData = await resSpot.json();
        const futData = await resFut.json();
        
        // Summation [16]
        const cvd_spot = spotData.data.reduce((sum, d) => sum + (d.buyVol - d.sellVol), 0);
        const cvd_futures = futData.data.reduce((sum, d) => sum + (d.buyVol - d.sellVol), 0);
        
        return { status: "success", cvd_spot, cvd_futures };
    } catch (e) { return { status: "error", message: e.message }; }
}