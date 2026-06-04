export async function coinglass_options_exchange_volume_trend_v4(symbol) {
    // Market Context: High-Volatility Breakout, Volume Volatility Squeeze [24, 30]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/option/volume/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current_vol = data.data[data.data.length - 1].volume;
        const mean_vol_30 = data.data.slice(-30).reduce((sum, d) => sum + d.volume, 0) / 30;
        
        const vol_ratio = current_vol / mean_vol_30; // [30]
        return { status: "success", vol_ratio };
    } catch (e) { return { status: "error", message: e.message }; }
}