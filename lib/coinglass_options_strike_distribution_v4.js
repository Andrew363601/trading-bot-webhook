export async function coinglass_options_strike_distribution_v4(symbol) {
    // Market Context: Options Open Interest Concentration [7, 27, 33]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/option/info?symbol=${symbol}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const puts_oi = data.data.puts.reduce((sum, p) => sum + p.oi, 0);
        const calls_oi = data.data.calls.reduce((sum, c) => sum + c.oi, 0);
        
        const pcr_oi = puts_oi / calls_oi; // [27]
        return { status: "success", pcr_oi };
    } catch (e) { return { status: "error", message: e.message }; }
}