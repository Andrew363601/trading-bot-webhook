export async function coinglass_etf_net_flow_momentum_v4(asset = 'BTC', k_days = 5) {
    // Market Context: Institutional Macro Trend-Following [19, 21, 33]
    try {
        const res = await fetch(`https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history?asset=${asset}`, {
            headers: { 'accept': 'application/json', 'CG-API-KEY': process.env.COINGLASS_API_KEY }
        });
        const data = await res.json();
        const target_data = data.data.slice(-k_days);
        const flow_accum = target_data.reduce((sum, d) => sum + d.netFlow, 0); // [21]
        return { status: "success", flow_accum };
    } catch (e) { return { status: "error", message: e.message }; }
}