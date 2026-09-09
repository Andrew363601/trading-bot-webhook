import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_large_limit_order_tracker_v4(symbol) {
    // Market Context: Institutional Wall Exploitation [18, 19]
    // Path migrated 2026-09-09: orderbook large-limit-order now lives under
    // the exchange-scoped history endpoint family.
    try {
        const data = await cgGet(`api/futures/orderbook/large-limit-order/history?symbol=${cgInstrument(symbol)}&exchange=Binance`);

        const rows = Array.isArray(data) ? data : [];
        const valid_walls = rows.filter(order => Number(order.valueUsd ?? order.value_usd ?? 0) >= 1000000); // [19]
        return { status: "success", valid_walls };
    } catch (e) { return { status: "error", message: e.message }; }
}