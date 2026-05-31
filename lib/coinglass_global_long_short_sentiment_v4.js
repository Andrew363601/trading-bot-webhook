export async function coinglass_global_long_short_sentiment_v4(symbol, k_hours = 168) {
    // Market Context: Retail Sentiment Divergence [6, 10]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/global-long-short-account-ratio/history?symbol=${symbol}&interval=1h`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const period_data = data.data.slice(-k_hours);
        const current = period_data[period_data.length - 1];
        
        const r_global = current.longAccounts / current.shortAccounts; // [10]
        const historical_r = period_data.map(d => d.longAccounts / d.shortAccounts);
        const mean_r = historical_r.reduce((a, b) => a + b, 0) / historical_r.length;
        const std_r = Math.sqrt(historical_r.reduce((a, b) => a + Math.pow(b - mean_r, 2), 0) / historical_r.length);
        
        const z_r = (r_global - mean_r) / std_r; // [10]
        return { status: "success", r_global, z_r };
    } catch (e) { return { status: "error", message: e.message }; }
}