export async function coinglass_exchange_wallet_assets_v4(exchange) {
    // Market Context: Solvency and Systemic Risk Tracking [21, 24]
    try {
        const res = await fetch(`https://open-api-v3.coinglass.com/api/v4/spot/exchange-assets?exchange=${exchange}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const total_usd = data.data.reduce((sum, a) => sum + a.valueUsd, 0);
        const hhi_assets = data.data.reduce((sum, a) => sum + Math.pow(a.valueUsd / total_usd, 2), 0); // [24]
        
        return { status: "success", hhi_assets, total_usd };
    } catch (e) { return { status: "error", message: e.message }; }
}