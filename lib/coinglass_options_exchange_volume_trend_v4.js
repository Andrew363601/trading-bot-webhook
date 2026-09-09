import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_options_exchange_volume_trend_v4(symbol) {
    // Market Context: High-Volatility Breakout, Volume Volatility Squeeze [24, 30]
    // NOTE: options volume history requires the exchange param post-migration.
    try {
        const data = await cgGet(`api/option/volume/history?symbol=${cgBase(symbol)}&exchange=Binance&interval=1h&limit=168`);
        const rows = Array.isArray(data) ? data : [];
        if (!rows.length) throw new Error('Options volume history returned no rows');

        const volOf = (d) => Number(d?.volume ?? d?.vol ?? 0);
        const current_vol = volOf(rows[rows.length - 1]);
        const tail = rows.slice(-30);
        const mean_vol_30 = tail.reduce((sum, d) => sum + volOf(d), 0) / (tail.length || 1);
        
        const vol_ratio = mean_vol_30 ? current_vol / mean_vol_30 : 0; // [30]
        return { status: "success", vol_ratio };
    } catch (e) { return { status: "error", message: e.message }; }
}