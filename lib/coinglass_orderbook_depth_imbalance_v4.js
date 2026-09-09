import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

export async function coinglass_orderbook_depth_imbalance_v4(symbol, interval) {
    // Market Context: Microstructure Scalping, Ranging [13, 17]
    // NOTE: old /futures/orderbook/ask-bids-history (single-exchange) is 404
    // since the v4 migration; interval is REQUIRED on the new path.
    try {
        const intervalParam = cgInterval(interval, '1h');
        const sym = cgInstrument(symbol);
        const attempts = [
            `api/futures/orderbook/aggregated-ask-bids-history?symbol=${sym}&exchange_list=Binance&interval=${intervalParam}`,
            `api/futures/orderbook/aggregated-ask-bids-history?symbol=${sym}&exchange_list=Binance,OKX&interval=${intervalParam}`,
            `api/futures/orderbook/aggregated-ask-bids-history?symbol=${sym}&exchange_list=Binance,OKX`,
        ];
        let data = null;
        let lastErr = null;
        for (const path of attempts) {
            try { data = await cgGet(path); break; } catch (e) { lastErr = e; }
        }
        if (!data) throw (lastErr || new Error('Orderbook depth imbalance unavailable'));

        const bid_sum = (Array.isArray(data?.bids) ? data.bids : []).reduce((sum, b) => sum + Number(b?.qty ?? b?.quantity ?? 0), 0);
        const ask_sum = (Array.isArray(data?.asks) ? data.asks : []).reduce((sum, a) => sum + Number(a?.qty ?? a?.quantity ?? 0), 0);
        if (!bid_sum && !ask_sum) throw new Error('Orderbook depth returned no rows');
        
        const obi = (bid_sum - ask_sum) / (bid_sum + ask_sum); // [17]
        return { status: "success", obi, bid_sum, ask_sum };
    } catch (e) { return { status: "error", message: e.message }; }
}