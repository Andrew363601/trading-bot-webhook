export async function coinglass_spot_cvd_divergence_v4(symbol, _legacy, interval) {
    // Market Context: Structural Trend-Following, Reversal Detection [16, 33]
    try {
        const intervalParam = interval ? `&interval=${interval}` : '';
        const resSpot = await fetch(`https://open-api-v3.coinglass.com/api/spot/taker-buy-sell-volume/history?symbol=${symbol}${intervalParam}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const resFut = await fetch(`https://open-api-v3.coinglass.com/api/futures/taker-buy-sell-volume/history?symbol=${symbol}${intervalParam}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const spotData = await resSpot.json();
        const futData = await resFut.json();
        
        if (!spotData || !spotData.data) throw new Error(spotData?.msg || spotData?.message || 'Invalid spot response from Coinglass');
        if (!futData || !futData.data) throw new Error(futData?.msg || futData?.message || 'Invalid futures response from Coinglass');

        // Summation [16]
        const spotRows = Array.isArray(spotData.data) ? spotData.data : [];
        const futRows = Array.isArray(futData.data) ? futData.data : [];
        const cvd_spot = spotRows.reduce((sum, d) => sum + (d.buyVol - d.sellVol), 0);
        const cvd_futures = futRows.reduce((sum, d) => sum + (d.buyVol - d.sellVol), 0);
        
        // Raw CUMULATIVE series for both spot + futures (running CVD over time).
        let runSpot = 0, runFut = 0;
        const series = spotRows.map((d, i) => {
            runSpot += (Number(d.buyVol) - Number(d.sellVol));
            const f = futRows[i];
            if (f) runFut += (Number(f.buyVol) - Number(f.sellVol));
            return { time: Math.floor(Number(d.timestamp || d.t || 0) / 1000), value: runSpot, cvd_futures: runFut };
        }).filter(p => p.time > 0);
        return { status: "success", cvd_spot, cvd_futures, series };
    } catch (e) { return { status: "error", message: e.message }; }
}