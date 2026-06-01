export async function coinglass_taker_buy_sell_ratio_v4(symbol, _legacy, interval = '15m') {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [5, 15]
    try {
        const tf = interval || '15m';
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/v2/taker-buy-sell-volume/history?symbol=${symbol}&interval=${tf}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const rows = Array.isArray(data.data) ? data.data : [];
        const current = rows[rows.length - 1];
        const r_taker = current.buyVol / current.sellVol; // [15]
        // Raw series: buy/sell ratio per bar.
        const series = rows.map(d => ({ time: Math.floor(Number(d.timestamp || d.t || 0) / 1000), value: Number(d.sellVol) ? Number(d.buyVol) / Number(d.sellVol) : 0, buyVol: Number(d.buyVol), sellVol: Number(d.sellVol) })).filter(p => p.time > 0);
        return { status: "success", r_taker, series };
    } catch (e) { return { status: "error", message: e.message }; }
}