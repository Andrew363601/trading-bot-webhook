import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_vol_weighted_funding_v4(symbol) {
    // Market Context: High-Velocity Breakdown, Momentum Breakout [9, 10]
    // NOTE: old /funding-rate/vol-weighted snapshot path is 404 since the v4
    // migration. Vol-weighted funding now comes from vol-weight history —
    // BASE symbol (BTC), not the instrument (BTCUSDT).
    try {
        const data = await cgGet(`api/futures/funding-rate/vol-weight-history?symbol=${cgBase(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        if (!rows.length) throw new Error('Vol-weighted funding history returned no rows');

        // Row shape: { time, volume, close (funding rate), ... }
        const total_vol = rows.reduce((sum, d) => sum + Number(d.volume ?? 0), 0) || 1;
        const fr_vol = rows.reduce((sum, d) => sum + (Number(d.close ?? 0) * Number(d.volume ?? 0)), 0) / total_vol; // [9]
        
        return { status: "success", fr_vol };
    } catch (e) { return { status: "error", message: e.message }; }
}