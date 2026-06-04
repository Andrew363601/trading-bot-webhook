export async function coinglass_top_account_long_short_v4(symbol) {
    // Market Context: Institutional Trend-Following [6, 11]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/futures/top-long-short-account-ratio?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const r_top_account = data.data.longAccounts / data.data.shortAccounts; // [11]
        return { status: "success", r_top_account };
    } catch (e) { return { status: "error", message: e.message }; }
}