export async function coinglass_oi_momentum_v4(symbol, n_minutes = 15, interval) {
    // Market Context: Macro Trend-Following, Short-Squeeze Regime [3, 9]
    try {
        const intervalParam = interval || `${n_minutes}m`;
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/open-interest/history?symbol=${symbol}&exchange=Binance&interval=${intervalParam}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        
        if (!data || !data.data) {
            throw new Error(data?.msg || data?.message || 'Invalid or empty response from Coinglass API');
        }

        const rows = Array.isArray(data.data) ? data.data : [];
        const current = rows[rows.length - 1] || { oi: 0, price: 0 };
        const past = rows[rows.length - 2] || { oi: 0, price: 0 };
        
        const delta_oi = past.oi ? (current.oi - past.oi) / past.oi : 0;
        const delta_p = past.price ? (current.price - past.price) / past.price : 0;
        const oi_momentum = delta_oi * Math.sign(delta_p); // [3]
        // Raw series: open interest per bar.
        const series = rows.map(d => {
            const rawTime = d.timestamp || d.t || (d.time ? d.time * 1000 : 0);
            return { time: Math.floor(Number(rawTime) / 1000), value: Number(d.oi), price: Number(d.price) };
        }).filter(p => p.time > 0 && Number.isFinite(p.value));
        return { status: "success", delta_oi, delta_p, oi_momentum, series };
    } catch (e) { return { status: "error", message: e.message }; }
}