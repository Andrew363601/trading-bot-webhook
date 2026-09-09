import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_top_account_long_short_v4(symbol) {
    // Market Context: Institutional Trend-Following [6, 11]
    // Snapshot path is gone — history endpoint with new field names.
    try {
        const data = await cgGet(`api/futures/top-long-short-account-ratio/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        const current = rows[rows.length - 1] || {};
        const r_top_account = Number(current.top_account_long_short_ratio
            ?? current.longAccountRatio ?? 0) || 1; // [11]
        return { status: "success", r_top_account };
    } catch (e) { return { status: "error", message: e.message }; }
}