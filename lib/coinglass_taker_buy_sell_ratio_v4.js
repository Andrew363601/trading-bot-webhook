export async function coinglass_taker_buy_sell_ratio_v4(symbol, _legacy, interval = '15m') {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [5, 15]
    try {
        const tf = interval || '15m';
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/v2/taker-buy-sell-volume/history?symbol=${symbol}&exchange=Binance&interval=${tf}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();

        if (!data || !data.data) {
            throw new Error(data?.msg || data?.message || 'Invalid or empty response from Coinglass API');
        }

        const rows = Array.isArray(data.data) ? data.data : [];
        const current = rows[rows.length - 1] || { buyVol: 0, sellVol: 1 };
        const r_taker = current.sellVol ? current.buyVol / current.sellVol : 0; // [15]
        // Raw series: buy/sell ratio per bar.
        const series = rows.map(d => {
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: Number(d.sellVol) ? Number(d.buyVol) / Number(d.sellVol) : 0, buyVol: Number(d.buyVol), sellVol: Number(d.sellVol) };
        }).filter(p => p.time > 0);
        return { status: "success", r_taker, series };
    } catch (e) { return { status: "error", message: e.message }; }
}