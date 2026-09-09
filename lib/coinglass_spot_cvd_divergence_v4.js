import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

export async function coinglass_spot_cvd_divergence_v4(symbol, interval) {
    // Market Context: Structural Trend-Following, Reversal Detection [16, 33]
    try {
        const intervalParam = cgInterval(interval, '1h');
        const sym = cgInstrument(symbol);
        const dataSpot = await cgGet(`api/spot/taker-buy-sell-volume/history?symbol=${sym}&exchange=Binance&interval=${intervalParam}&limit=168`);
        // Futures leg: old /futures/taker-buy-sell-volume/history is 404 since
        // the v4 migration — use the aggregated endpoint with exchange_list.
        const dataFut = await cgGet(`api/futures/aggregated-taker-buy-sell-volume/history?symbol=${sym}&exchange_list=Binance&interval=${intervalParam}&limit=168`);

        const spotRows = Array.isArray(dataSpot) ? dataSpot : [];
        const futRows = Array.isArray(dataFut) ? dataFut : [];
        const cvd_spot = spotRows.reduce((sum, d) => sum + ((Number(d.buyVol) || 0) - (Number(d.sellVol) || 0)), 0);
        const cvd_futures = futRows.reduce((sum, d) => sum + ((Number(d.buyVol) || 0) - (Number(d.sellVol) || 0)), 0);
        
        // Raw CUMULATIVE series for both spot + futures (running CVD over time).
        let runSpot = 0, runFut = 0;
        const series = spotRows.map((d, i) => {
            runSpot += ((Number(d.buyVol) || 0) - (Number(d.sellVol) || 0));
            const f = futRows[i];
            if (f) runFut += ((Number(f.buyVol) || 0) - (Number(f.sellVol) || 0));
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: runSpot, cvd_futures: runFut };
        }).filter(p => p.time > 0).reverse();
        return { status: "success", cvd_spot, cvd_futures, series };
    } catch (e) { return { status: "error", message: e.message }; }
}