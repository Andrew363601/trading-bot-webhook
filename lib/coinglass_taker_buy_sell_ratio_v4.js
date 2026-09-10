import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

export async function coinglass_taker_buy_sell_ratio_v4(symbol, interval) {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [5, 15]
    try {
        const tf = cgInterval(interval);
        const data = await cgGet(`api/futures/v2/taker-buy-sell-volume/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=${tf}&limit=168`);

        const rows = Array.isArray(data) ? data : [];
        // Field names verified live 2026-09-09: Coinglass renamed rows to
        // taker_buy_volume_usd / taker_sell_volume_usd (old buyVol/sellVol are gone).
        const allZero = rows.length > 0 && rows.every(d => !Number(d.taker_buy_volume_usd) && !Number(d.taker_sell_volume_usd));
        if (allZero) {
            return { status: "error", message: "Taker buy/sell series returned all-zero volumes (plan or endpoint limitation) — no flow evidence available. Do NOT treat this as neutral flow; fetch native CVD from market state instead." };
        }
        const current = rows[rows.length - 1] || { taker_buy_volume_usd: 0, taker_sell_volume_usd: 1 };
        const r_taker = current.taker_sell_volume_usd ? current.taker_buy_volume_usd / current.taker_sell_volume_usd : 0; // [15]
        // Raw series: buy/sell ratio per bar.
        const series = rows.map(d => {
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            const buyVol = Number(d.taker_buy_volume_usd), sellVol = Number(d.taker_sell_volume_usd);
            return { time: tNum, value: sellVol ? buyVol / sellVol : 0, buyVol, sellVol };
        }).filter(p => p.time > 0).reverse();
        return { status: "success", r_taker, series };
    } catch (e) { return { status: "error", message: e.message }; }
}