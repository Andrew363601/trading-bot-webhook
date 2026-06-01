export async function coinglass_oi_momentum_v4(symbol, n_minutes = 15, interval) {
    // Market Context: Macro Trend-Following, Short-Squeeze Regime [3, 9]
    try {
        const intervalParam = interval || `${n_minutes}m`;
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/open-interest/history?symbol=${symbol}&interval=${intervalParam}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const rows = Array.isArray(data.data) ? data.data : [];
        const current = rows[rows.length - 1];
        const past = rows[rows.length - 2];
        
        const delta_oi = (current.oi - past.oi) / past.oi;
        const delta_p = (current.price - past.price) / past.price;
        const oi_momentum = delta_oi * Math.sign(delta_p); // [3]
        // Raw series: open interest per bar.
        const series = rows.map(d => ({ time: Math.floor(Number(d.timestamp || d.t || 0) / 1000), value: Number(d.oi), price: Number(d.price) })).filter(p => p.time > 0 && Number.isFinite(p.value));
        return { status: "success", delta_oi, delta_p, oi_momentum, series };
    } catch (e) { return { status: "error", message: e.message }; }
}