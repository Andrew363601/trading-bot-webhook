export async function coinglass_options_exchange_oi_trend_v4(symbol) {
    // Market Context: Volatility Expansion & Hedging Regimes [23, 29]
    try {
        const resOpt = await fetch(`https://open-api-v4.coinglass.com/api/option/oi/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const resFut = await fetch(`https://open-api-v4.coinglass.com/api/futures/open-interest/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const optData = await resOpt.json();
        const futData = await resFut.json();
        
        const current_opt = optData.data[optData.data.length - 1];
        const past_opt = optData.data[optData.data.length - 25]; // 24h assuming hourly
        
        const oi_ratio = current_opt.oi / futData.data[futData.data.length - 1].oi; // [29]
        const slope_options_oi = (current_opt.oi - past_opt.oi) / 24; // [29]
        
        return { status: "success", oi_ratio, slope_options_oi };
    } catch (e) { return { status: "error", message: e.message }; }
}