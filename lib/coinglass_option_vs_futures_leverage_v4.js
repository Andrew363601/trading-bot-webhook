export async function coinglass_option_vs_futures_leverage_v4(symbol) {
    // Market Context: Systemic Leverage Regime Shift [25, 31]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/option/futures-oi-ratio?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const lambda_ratio = data.data.ratio; // [31]
        return { status: "success", lambda_ratio };
    } catch (e) { return { status: "error", message: e.message }; }
}