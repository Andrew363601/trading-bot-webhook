export async function coinglass_funding_rate_reversion_v4(symbol, k_minutes = 1440) {
    // Market Context: Mean-Reversion, Speculative Exhaustion [5, 9]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/funding-rate/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const fr_array = data.data.slice(-k_minutes).map(d => d.fundingRate);
        const current_fr = fr_array[fr_array.length - 1];
        
        const mean_fr = fr_array.reduce((a, b) => a + b, 0) / fr_array.length;
        const variance = fr_array.reduce((a, b) => a + Math.pow(b - mean_fr, 2), 0) / fr_array.length;
        const std_fr = Math.sqrt(variance);
        
        const z_fr = (current_fr - mean_fr) / std_fr; // [5]
        return { status: "success", current_fr, z_fr };
    } catch (e) { return { status: "error", message: e.message }; }
}