export async function coinglass_large_limit_order_tracker_v4(symbol) {
    // Market Context: Institutional Wall Exploitation [18, 19]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/futures/orderbook/large-limit-order?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const valid_walls = data.data.filter(order => order.valueUsd >= 1000000); // [19]
        return { status: "success", valid_walls };
    } catch (e) { return { status: "error", message: e.message }; }
}