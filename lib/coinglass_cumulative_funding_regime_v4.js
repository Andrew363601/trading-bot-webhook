import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_cumulative_funding_regime_v4(symbol, tau_intervals = 9) {
    // Market Context: Macro Trend-Following, Carry Trade Execution [7, 16]
    // NOTE: the old /funding-rate/cumulative path is 404 since the v4 migration.
    // Cumulative funding is now computed from the funding-rate history endpoint.
    try {
        const data = await cgGet(`api/futures/funding-rate/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        const target_data = rows.slice(-tau_intervals);
        const cfr = target_data.reduce((sum, d) => sum + Number(d.fundingRate ?? d.close ?? 0), 0); // [7]
        
        return { status: "success", cfr_tau: cfr };
    } catch (e) { return { status: "error", message: e.message }; }
}