export async function coinglass_top_position_long_short_v4(symbol) {
    // Market Context: High-Velocity Breakout [6, 12]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/futures/top-long-short-position-ratio?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const r_top_position = data.data.longPositions / data.data.shortPositions; // [12]
        return { status: "success", r_top_position };
    } catch (e) { return { status: "error", message: e.message }; }
}