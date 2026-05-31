export async function coinglass_bitcoin_profitable_days_v4() {
    // Market Context: Macro-Cycle Exhaustion, High-Probability Trend Continuation [26, 32]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/index/bitcoin/profitable-days?symbol=BTC`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const pi_profitable = (data.data.profitableDays / data.data.totalDays) * 100; // [32]
        return { status: "success", pi_profitable };
    } catch (e) { return { status: "error", message: e.message }; }
}