import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_option_vs_futures_leverage_v4(symbol) {
    // Market Context: Systemic Leverage Regime Shift [25, 31]
    // NOTE: old /api/option/futures-oi-ratio path is 404 since the v4
    // migration. New index endpoint — BASE symbol, field is
    // `btc_option_vs_futures_radio` (sic — Coinglass typo, keep as-is).
    try {
        const data = await cgGet(`api/index/option-vs-futures-oi-ratio?symbol=${cgBase(symbol)}`);
        const row = Array.isArray(data) ? data[data.length - 1] : data;
        const lambda_ratio = Number(row?.btc_option_vs_futures_radio ?? row?.ratio ?? 0); // [31]
        return { status: "success", lambda_ratio };
    } catch (e) { return { status: "error", message: e.message }; }
}