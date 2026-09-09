import { cgGet, cgBase, cgInterval } from './coinglass-api.js';

export async function coinglass_options_exchange_oi_trend_v4(symbol) {
    // Market Context: Volatility Expansion & Hedging Regimes [23, 29]
    // NOTE: paths updated post-v4-migration; options history requires the
    // exchange param and the futures leg needs an explicit interval.
    try {
        const base = cgBase(symbol);
        const dataOpt = await cgGet(`api/option/oi/history?symbol=${base}&exchange=Binance&interval=1h&limit=168`);
        const dataFut = await cgGet(`api/futures/open-interest/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=${cgInterval('1h')}&limit=168`);
        
        const optRows = Array.isArray(dataOpt) ? dataOpt : [];
        const futRows = Array.isArray(dataFut) ? dataFut : [];
        if (!optRows.length || !futRows.length) throw new Error('Options/Futures OI history returned no rows');

        const oiOf = (d) => Number(d?.oi ?? d?.openInterest ?? d?.close ?? 0);
        const current_opt = optRows[optRows.length - 1];
        const past_opt = optRows[optRows.length - 25] || optRows[0]; // 24h assuming hourly
        
        const oi_ratio = oiOf(current_opt) / (oiOf(futRows[futRows.length - 1]) || 1); // [29]
        const slope_options_oi = (oiOf(current_opt) - oiOf(past_opt)) / 24; // [29]
        
        return { status: "success", oi_ratio, slope_options_oi };
    } catch (e) { return { status: "error", message: e.message }; }
}