export async function coinglass_exchange_balance_reserve_v4(symbol) {
    // Market Context: Structural Supply Shock [8, 22, 33]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/v4/spot/exchange-balance/history?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const current = data.data[data.data.length - 1].balance;
        const bal_24h = data.data[data.data.length - 2].balance; // Mock indices for 24h/7d
        const bal_7d = data.data[data.data.length - 8].balance;
        
        const delta_bal_24h = ((current - bal_24h) / bal_24h) * 100; // [22]
        const delta_bal_7d = ((current - bal_7d) / bal_7d) * 100; // [22]
        
        return { status: "success", delta_bal_24h, delta_bal_7d };
    } catch (e) { return { status: "error", message: e.message }; }
}