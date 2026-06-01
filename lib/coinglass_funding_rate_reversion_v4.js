export async function coinglass_funding_rate_reversion_v4(symbol, k_minutes = 1440, interval) {
    // Market Context: Mean-Reversion, Speculative Exhaustion [5, 9]
    try {
        const intervalParam = interval ? `&interval=${interval}` : '';
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/funding-rate/history?symbol=${symbol}&exchange=Binance${intervalParam}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();

        if (!data || !data.data) {
            throw new Error(data?.msg || data?.message || 'Invalid or empty response from Coinglass API');
        }

        const rows = Array.isArray(data.data) ? data.data.slice(-k_minutes) : [];
        const fr_array = rows.map(d => Number(d.fundingRate ?? d.close ?? 0));
        const current_fr = fr_array[fr_array.length - 1] || 0;
        
        const mean_fr = fr_array.reduce((a, b) => a + b, 0) / (fr_array.length || 1);
        const variance = fr_array.reduce((a, b) => a + Math.pow(b - mean_fr, 2), 0) / (fr_array.length || 1);
        const std_fr = Math.sqrt(variance) || 1;
        
        const z_fr = (current_fr - mean_fr) / std_fr; // [5]
        // Raw series for heatmap/strip rendering. Coinglass sometimes returns 'time' in seconds instead of 'timestamp'.
        const series = rows.map(d => {
            const rawTime = d.timestamp || d.t || (d.time ? d.time * 1000 : 0);
            return { time: Math.floor(Number(rawTime) / 1000), value: Number(d.fundingRate ?? d.close ?? 0) };
        }).filter(p => p.time > 0 && Number.isFinite(p.value));
        
        return { status: "success", current_fr, z_fr, series };
    } catch (e) { return { status: "error", message: e.message }; }
}