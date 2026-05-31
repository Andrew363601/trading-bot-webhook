export async function coinglass_taker_buy_sell_ratio_v4(symbol) {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [5, 15]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/v2/taker-buy-sell-volume/history?symbol=${symbol}&interval=15m`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current = data.data[data.data.length - 1];
        const r_taker = current.buyVol / current.sellVol; // [15]
        return { status: "success", r_taker };
    } catch (e) { return { status: "error", message: e.message }; }
}