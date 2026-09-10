import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

export async function coinglass_global_long_short_sentiment_v4(symbol, k_hours = 168, interval) {
    // Market Context: Retail Sentiment Divergence [6, 10]
    // Field mapping (verified 2026-09-09): rows now carry
    // `global_account_long_short_ratio` + long/shortAccountPercent. Old
    // longAccounts/shortAccounts fields are gone from this endpoint.
    try {
        const intervalParam = cgInterval(interval);
        const data = await cgGet(`api/futures/global-long-short-account-ratio/history?symbol=${cgInstrument(symbol)}&exchange=Binance&interval=${intervalParam}&limit=168`);

        const rows = Array.isArray(data) ? data : [];
        const ratioOf = (d) => Number(
            d?.global_account_long_short_ratio
            ?? d?.longAccountRatio ?? d?.longAccounts
            ?? 0
        );
        const pctOf = (d, kind) => Number(
            kind === 'long'
                ? (d?.longAccountPercent ?? d?.longAccounts ?? 0)
                : (d?.shortAccountPercent ?? d?.shortAccounts ?? 0)
        );

        const period_data = rows.slice(-k_hours);
        const current = period_data[period_data.length - 1] || null;
        if (!current) throw new Error('Global long/short history returned no rows');
        
        const r_global = ratioOf(current) || 1; // [10]
        const historical_r = period_data.map(d => ratioOf(d) || 0);
        const mean_r = historical_r.reduce((a, b) => a + b, 0) / (historical_r.length || 1);
        const std_r = Math.sqrt(historical_r.reduce((a, b) => a + Math.pow(b - mean_r, 2), 0) / (historical_r.length || 1)) || 1;
        
        const z_r = (r_global - mean_r) / std_r; // [10]
        // Raw series: long/short account ratio per bar.
        const series = period_data.map(d => {
            let tNum = Number(d.time ?? d.timestamp ?? d.t ?? d.createTime ?? 0);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: ratioOf(d), long_pct: pctOf(d, 'long'), short_pct: pctOf(d, 'short') };
        }).filter(p => p.time > 0).reverse();
        return { status: "success", r_global, z_r, series };
    } catch (e) { return { status: "error", message: e.message }; }
}