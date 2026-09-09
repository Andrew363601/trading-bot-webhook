import { cgGet, cgInstrument } from './coinglass-api.js';

export async function coinglass_aggregated_liquidation_map_v4(symbol, range_percent = 1.5) {
    // Market Context: Liquidity Hunt, Sweep of Lows/Highs [14, 35]
    try {
        const data = await cgGet(`api/futures/liquidation/aggregated-map?symbol=${cgInstrument(symbol)}`);

        // Integration Logic mapped to density [14]
        const current_price = data.currentPrice;
        const allPools = Array.isArray(data.pools) ? data.pools : [];
        let high_density_pools = allPools.filter(p => Math.abs((p.price - current_price)/current_price) <= (range_percent/100));

        // Expose a normalized density grid for the front-end heatmap. Each entry
        // is { price, intensity (0..1), volume, side }. Intensity is the pool
        // volume scaled against the densest pool in the returned window, so the
        // chart can paint a price-band heat gradient (legend.coinglass.com style,
        // price axis only since this endpoint has no time dimension).
        const volumes = high_density_pools.map(p => Math.abs(parseFloat(p.volume ?? p.qty ?? p.amount ?? 0)) || 0);
        const maxVol = volumes.length ? Math.max(...volumes) : 0;
        const heatmap = high_density_pools.map((p) => {
            const vol = Math.abs(parseFloat(p.volume ?? p.qty ?? p.amount ?? 0)) || 0;
            return {
                price: parseFloat(p.price),
                volume: vol,
                intensity: maxVol > 0 ? +(vol / maxVol).toFixed(4) : 0,
                side: p.side || null,
            };
        }).filter(p => Number.isFinite(p.price));

        return { status: "success", current_price, high_density_pools, heatmap };
    } catch (e) { return { status: "error", message: e.message }; }
}