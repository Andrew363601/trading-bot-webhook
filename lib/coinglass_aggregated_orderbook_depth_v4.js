import { cgGet, cgInstrument, cgInterval } from './coinglass-api.js';

export async function coinglass_aggregated_orderbook_depth_v4(symbol, interval) {
    // Market Context: Institutional Liquidity Sourcing [12, 18]
    // NOTE: old /futures/orderbook/aggregated snapshot path is 404 since the
    // v4 migration. New aggregated-ask-bids-history path uses exchange_list.
    try {
        const intervalParam = cgInterval(interval, '1h');
        const sym = cgInstrument(symbol);
        // Verified path; if Binance-only returns empty rows, widen the venue
        // list, then try without interval as a last resort.
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
        if (!data) throw (lastErr || new Error('Aggregated orderbook depth unavailable'));

        // Response shape may be { bids: [...], asks: [...] } or a row list.
        const bid_sum = (Array.isArray(data?.bids) ? data.bids : []).reduce((sum, b) => sum + Number(b?.qty ?? b?.quantity ?? 0), 0);
        const ask_sum = (Array.isArray(data?.asks) ? data.asks : []).reduce((sum, a) => sum + Number(a?.qty ?? a?.quantity ?? 0), 0);
        if (!bid_sum && !ask_sum) throw new Error('Aggregated orderbook depth returned no rows');
        
        const agg_depth_imbalance = (bid_sum - ask_sum) / (bid_sum + ask_sum); // [18]
        return { status: "success", agg_depth_imbalance, bid_sum, ask_sum };
    } catch (e) { return { status: "error", message: e.message }; }
}