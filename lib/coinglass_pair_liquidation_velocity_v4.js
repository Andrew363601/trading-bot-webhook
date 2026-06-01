export async function coinglass_pair_liquidation_velocity_v4(symbol, m_periods = 288, interval = '5m') {
    // Market Context: Mean-Reversion, Liquidation Capitulation [3, 13]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/liquidation/history?symbol=${symbol}&exchange=Binance&interval=${interval}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();

        if (!data || !data.data) {
            throw new Error(data?.msg || data?.message || 'Invalid or empty response from Coinglass API');
        }

        const target_data = Array.isArray(data.data) ? data.data.slice(-m_periods) : [];
        const current = target_data[target_data.length - 1] || { longVol: 0, shortVol: 0 };
        
        const liq_delta = current.shortVol - current.longVol; // [13]
        const mean_long_liq = target_data.reduce((sum, d) => sum + d.longVol, 0) / (target_data.length || 1);
        const std_long_liq = Math.sqrt(target_data.reduce((sum, d) => sum + Math.pow(d.longVol - mean_long_liq, 2), 0) / (target_data.length || 1)) || 1;
        
        const z_liq_long = (current.longVol - mean_long_liq) / std_long_liq; // [13]
        // Raw series: net liquidation (short - long) per bar; positive = shorts rekt.
        const series = target_data.map(d => {
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: Number(d.shortVol) - Number(d.longVol), longVol: Number(d.longVol), shortVol: Number(d.shortVol) };
        }).filter(p => p.time > 0);
        return { status: "success", liq_delta, z_liq_long, series };
    } catch (e) { return { status: "error", message: e.message }; }
}