import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_oi_weighted_funding_v4(symbol) {
    // Market Context: Institutional Position Analysis [6, 8, 17]
    // NOTE: the old /funding-rate/oi-weighted snapshot path is 404 since the
    // v4 migration. OI-weighted funding now comes from the oi-weight history
    // endpoint — BASE symbol (BTC), not the instrument (BTCUSDT).
    try {
        const data = await cgGet(`api/futures/funding-rate/oi-weight-history?symbol=${cgBase(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        if (!rows.length) throw new Error('OI-weighted funding history returned no rows');

        // Row shape: { time, oi, close (funding rate), open, ... }
        const total_oi = rows.reduce((sum, d) => sum + Number(d.oi ?? 0), 0) || 1;
        const weighted_sum = rows.reduce((sum, d) => sum + (Number(d.close ?? 0) * Number(d.oi ?? 0)), 0);
        const raw_sum = rows.reduce((sum, d) => sum + Number(d.close ?? 0), 0);

        const fr_oi = weighted_sum / total_oi;
        const avg_fr = raw_sum / rows.length;
        const divergence = Math.abs(fr_oi - avg_fr);

        return { status: "success", fr_oi, divergence };
    } catch (e) { return { status: "error", message: e.message }; }
}