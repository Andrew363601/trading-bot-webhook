export async function coinglass_oi_weighted_funding_v4(symbol) {
    // Market Context: Institutional Position Analysis [6, 8, 17]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/funding-rate/oi-weighted?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        let total_oi = 0;
        let weighted_sum = 0;
        let raw_sum = 0;
        
        data.data.forEach(ex => {
            total_oi += ex.oi;
            raw_sum += ex.fundingRate;
        });
        data.data.forEach(ex => {
            weighted_sum += (ex.fundingRate * (ex.oi / total_oi)); // [8]
        });
        
        const fr_oi = weighted_sum;
        const avg_fr = raw_sum / data.data.length;
        const divergence = Math.abs(fr_oi - avg_fr);
        
        return { status: "success", fr_oi, divergence };
    } catch (e) { return { status: "error", message: e.message }; }
}