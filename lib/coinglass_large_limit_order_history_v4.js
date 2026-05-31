export async function coinglass_large_limit_order_history_v4(symbol) {
    // Market Context: Post-Fill Momentum [4, 20]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/orderbook/large-limit-order/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const cancelled = data.data.filter(d => d.state === 0).length; // assuming 0 is revoked
        const total = data.data.length;
        const cancel_rate = total > 0 ? cancelled / total : 0; // [20]
        return { status: "success", cancel_rate };
    } catch (e) { return { status: "error", message: e.message }; }
}