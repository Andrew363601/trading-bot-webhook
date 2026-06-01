export async function coinglass_global_long_short_sentiment_v4(symbol, k_hours = 168, interval = '1h') {
    // Market Context: Retail Sentiment Divergence [6, 10]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/global-long-short-account-ratio/history?symbol=${symbol}&interval=${interval}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        
        if (!data || !data.data) {
            throw new Error(data?.msg || data?.message || 'Invalid or empty response from Coinglass API');
        }

        const period_data = Array.isArray(data.data) ? data.data.slice(-k_hours) : [];
        const current = period_data[period_data.length - 1] || { longAccounts: 0, shortAccounts: 1 };
        
        const r_global = current.longAccounts / current.shortAccounts; // [10]
        const historical_r = period_data.map(d => d.shortAccounts ? d.longAccounts / d.shortAccounts : 0);
        const mean_r = historical_r.reduce((a, b) => a + b, 0) / (historical_r.length || 1);
        const std_r = Math.sqrt(historical_r.reduce((a, b) => a + Math.pow(b - mean_r, 2), 0) / (historical_r.length || 1)) || 1;
        
        const z_r = (r_global - mean_r) / std_r; // [10]
        // Raw series: long/short account ratio per bar.
        const series = period_data.map(d => {
            const rawTime = d.timestamp || d.t || (d.time ? d.time * 1000 : 0);
            return { time: Math.floor(Number(rawTime) / 1000), value: Number(d.shortAccounts) ? Number(d.longAccounts) / Number(d.shortAccounts) : 0 };
        }).filter(p => p.time > 0);
        return { status: "success", r_global, z_r, series };
    } catch (e) { return { status: "error", message: e.message }; }
}