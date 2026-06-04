export async function coinglass_exchange_balance_trend_v4(symbol, k_days = 30) {
    // Market Context: Macro Trend-Following [20, 23]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/v4/spot/exchange-balance/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current = data.data[data.data.length - 1].balance;
        const past = data.data[data.data.length - 1 - k_days].balance;
        
        const theta_velocity = (current - past) / k_days; // [23]
        return { status: "success", theta_velocity };
    } catch (e) { return { status: "error", message: e.message }; }
}