import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

// Signature preserved: pages/api/coinglass-indicator.js calls this 3-arg
// (symbol, undefined, interval). The middle slot is the legacy n_minutes arg.
export async function coinglass_oi_momentum_v4(symbol, _legacy_minutes, interval) {
    // Market Context: Macro Trend-Following, Short-Squeeze Regime [3, 9]
    try {
        const intervalParam = cgInterval(interval);
        const data = await cgGet(`api/futures/open-interest/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=${intervalParam}&limit=168`);

        const rows = Array.isArray(data) ? data : [];
        const current = rows[rows.length - 1] || { oi: 0, price: 0 };
        const past = rows[rows.length - 2] || { oi: 0, price: 0 };
        
        const delta_oi = past.oi ? (current.oi - past.oi) / past.oi : 0;
        const delta_p = past.price ? (current.price - past.price) / past.price : 0;
        const oi_momentum = delta_oi * Math.sign(delta_p); // [3]
        // Raw series: open interest per bar.
        const series = rows.map(d => {
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: Number(d.oi ?? d.close ?? 0), price: Number(d.price ?? d.close ?? 0) };
        }).filter(p => p.time > 0 && Number.isFinite(p.value)).reverse();
        return { status: "success", delta_oi, delta_p, oi_momentum, series };
    } catch (e) { return { status: "error", message: e.message }; }
}