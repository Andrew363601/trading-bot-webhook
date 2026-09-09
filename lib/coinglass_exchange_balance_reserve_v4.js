import { cgGet, cgBase } from './coinglass-api.js';

export async function coinglass_exchange_balance_reserve_v4(symbol) {
    // Market Context: Structural Supply Shock [8, 22, 33]
    // NOTE: old /v4/spot/exchange-balance/history path is 404 since the v4
    // migration. New chart endpoint — BASE symbol, response is
    // { time_list, price_list, data_map }.
    try {
        const data = await cgGet(`api/exchange/balance/chart?symbol=${cgBase(symbol)}&exchange_list=Binance,OKX,Bybit`);

        const time_list = Array.isArray(data?.time_list) ? data.time_list : [];
        const data_map = data?.data_map || {};
        if (!time_list.length || !Object.keys(data_map).length) {
            throw new Error('Exchange balance chart returned no rows');
        }

        const series = time_list.map((t, i) => {
            const total = Object.values(data_map).reduce((sum, arr) => sum + Number(arr?.[i] ?? 0), 0);
            let tNum = Number(t);
            if (tNum > 1e11) tNum = Math.floor(tNum / 1000);
            return { time: tNum, value: total };
        }).filter(p => p.time > 0 && Number.isFinite(p.value));

        if (series.length < 8) throw new Error('Exchange balance chart returned insufficient rows');

        const current = series[series.length - 1].value;
        const bal_24h = series[series.length - 2].value;
        const bal_7d = series[series.length - 8].value;
        
        const delta_bal_24h = bal_24h ? ((current - bal_24h) / bal_24h) * 100 : 0; // [22]
        const delta_bal_7d = bal_7d ? ((current - bal_7d) / bal_7d) * 100 : 0; // [22]
        
        return { status: "success", delta_bal_24h, delta_bal_7d, series };
    } catch (e) { return { status: "error", message: e.message }; }
}