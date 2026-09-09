import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_large_limit_order_history_v4(symbol) {
    // Market Context: Post-Fill Momentum [4, 20]
    try {
        const data = await cgGet(`api/futures/orderbook/large-limit-order/history?symbol=${cgInstrument(symbol)}&exchange=Binance`);
        const rows = Array.isArray(data) ? data : [];
        const cancelled = rows.filter(d => (d.state ?? d.status) === 0).length; // assuming 0 is revoked
        const total = rows.length;
        const cancel_rate = total > 0 ? cancelled / total : 0; // [20]
        return { status: "success", cancel_rate };
    } catch (e) { return { status: "error", message: e.message }; }
}