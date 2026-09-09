import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_exchange_balance_trend_v4(symbol, k_days = 30) {
    // Market Context: Macro Trend-Following [20, 23]
    // NOTE: old /v4/spot/exchange-balance/history path is 404 since the v4
    // migration. New chart endpoint — BASE symbol, response is
    // { time_list, price_list, data_map } where data_map[exchange] is a
    // per-day balance array aligned with time_list.
    try {
        const data = await cgGet(`api/exchange/balance/chart?symbol=${cgBase(symbol)}&exchange_list=Binance,OKX,Bybit`);

        const time_list = Array.isArray(data?.time_list) ? data.time_list : [];
        const data_map = data?.data_map || {};
        if (!time_list.length || !Object.keys(data_map).length) {
            throw new Error('Exchange balance chart returned no rows');
        }

        // Sum balances across exchanges per day.
        const series = time_list.map((t, i) => {
            const total = Object.values(data_map).reduce((sum, arr) => sum + Number(arr?.[i] ?? 0), 0);
            let tNum = Number(t);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: total };
        }).filter(p => p.time > 0 && Number.isFinite(p.value));

        if (series.length < 2) throw new Error('Exchange balance chart returned insufficient rows');

        const current = series[series.length - 1].value;
        const pastIdx = Math.max(0, series.length - 1 - k_days);
        const past = series[pastIdx].value;

        const theta_velocity = (current - past) / Math.max(1, (series.length - 1 - pastIdx)); // [23]
        return { status: "success", theta_velocity, series };
    } catch (e) { return { status: "error", message: e.message }; }
}