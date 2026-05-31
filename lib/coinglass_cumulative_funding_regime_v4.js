export async function coinglass_cumulative_funding_regime_v4(symbol, tau_intervals = 9) {
    // Market Context: Macro Trend-Following, Carry Trade Execution [7, 16]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/funding-rate/cumulative?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const target_data = data.data.slice(-tau_intervals);
        const cfr = target_data.reduce((sum, d) => sum + d.fundingRate, 0); // [7]
        
        return { status: "success", cfr_tau: cfr };
    } catch (e) { return { status: "error", message: e.message }; }
}