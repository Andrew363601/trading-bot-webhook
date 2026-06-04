export async function coinglass_options_max_pain_pin_v4(symbol) {
    // Market Context: Options Expiry Pinning Strategy [11, 28]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/option/max-pain?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const max_pain = data.data.maxPainPrice; // [28]
        return { status: "success", max_pain };
    } catch (e) { return { status: "error", message: e.message }; }
}