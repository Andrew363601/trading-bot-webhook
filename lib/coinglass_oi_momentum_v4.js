export async function coinglass_oi_momentum_v4(symbol, n_minutes = 15) {
    // Market Context: Macro Trend-Following, Short-Squeeze Regime [3, 9]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/open-interest/history?symbol=${symbol}&interval=${n_minutes}m`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current = data.data[data.data.length - 1];
        const past = data.data[data.data.length - 2];
        
        const delta_oi = (current.oi - past.oi) / past.oi;
        const delta_p = (current.price - past.price) / past.price;
        const oi_momentum = delta_oi * Math.sign(delta_p); // [3]
        
        return { status: "success", delta_oi, delta_p, oi_momentum };
    } catch (e) { return { status: "error", message: e.message }; }
}