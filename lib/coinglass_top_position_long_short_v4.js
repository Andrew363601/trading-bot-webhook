import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_top_position_long_short_v4(symbol) {
    // Market Context: High-Velocity Breakout [6, 12]
    // Snapshot path is gone — history endpoint with new field names.
    try {
        const data = await cgGet(`api/futures/top-long-short-position-ratio/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        const current = rows[rows.length - 1] || {};
        const r_top_position = Number(current.top_position_long_short_ratio
            ?? current.longPositionRatio ?? 0) || 1; // [12]
        return { status: "success", r_top_position };
    } catch (e) { return { status: "error", message: e.message }; }
}