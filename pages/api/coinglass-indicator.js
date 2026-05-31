// pages/api/coinglass-indicator.js
//
// Authenticated proxy that exposes the lib/coinglass_*_v4 indicator functions
// to the front-end chart. We never expose the COINGLASS_API_KEY to the browser
// and we always require a Bearer token so anonymous traffic can't burn quota.
//
// Request:  GET /api/coinglass-indicator?id=<INDICATOR_ID>&symbol=<SYMBOL>[&...]
// Response: { id, symbol, kind: 'overlay'|'pane', data: <indicator-specific> }
//
// `kind` is a hint for the front-end to choose its render strategy:
//   - 'overlay' = renders ON TOP of the price chart (e.g. liquidity heatmap,
//                 large-limit-order walls, aggregated liquidation map). On
//                 mobile these stay visible even when the chart is collapsed.
//   - 'pane'    = renders STACKED BELOW the chart (funding, OI, CVD, etc.).
//                 On mobile these auto-hide when the chart is collapsed to
//                 avoid bloat — overlays remain visible.

import { withTenantAuth } from '../../lib/auth-middleware.js';

// Lazy-import each indicator so we don't load 30 files unless requested.
const INDICATOR_REGISTRY = {
    liquidation_map:           { kind: 'overlay', loader: () => import('../../lib/coinglass_aggregated_liquidation_map_v4.js').then(m => m.coinglass_aggregated_liquidation_map_v4) },
    large_limit_orders:        { kind: 'overlay', loader: () => import('../../lib/coinglass_large_limit_order_tracker_v4.js').then(m => m.coinglass_large_limit_order_tracker_v4) },
    orderbook_depth:           { kind: 'overlay', loader: () => import('../../lib/coinglass_aggregated_orderbook_depth_v4.js').then(m => m.coinglass_aggregated_orderbook_depth_v4) },
    funding_rate:              { kind: 'pane',    loader: () => import('../../lib/coinglass_funding_rate_reversion_v4.js').then(m => m.coinglass_funding_rate_reversion_v4) },
    oi_momentum:               { kind: 'pane',    loader: () => import('../../lib/coinglass_oi_momentum_v4.js').then(m => m.coinglass_oi_momentum_v4) },
    spot_cvd_divergence:       { kind: 'pane',    loader: () => import('../../lib/coinglass_spot_cvd_divergence_v4.js').then(m => m.coinglass_spot_cvd_divergence_v4) },
    long_short_sentiment:      { kind: 'pane',    loader: () => import('../../lib/coinglass_global_long_short_sentiment_v4.js').then(m => m.coinglass_global_long_short_sentiment_v4) },
    taker_buy_sell_ratio:      { kind: 'pane',    loader: () => import('../../lib/coinglass_taker_buy_sell_ratio_v4.js').then(m => m.coinglass_taker_buy_sell_ratio_v4) },
    liquidation_velocity:      { kind: 'pane',    loader: () => import('../../lib/coinglass_pair_liquidation_velocity_v4.js').then(m => m.coinglass_pair_liquidation_velocity_v4) },
    orderbook_imbalance:       { kind: 'pane',    loader: () => import('../../lib/coinglass_orderbook_depth_imbalance_v4.js').then(m => m.coinglass_orderbook_depth_imbalance_v4) },
};

export const INDICATOR_CATALOG = Object.entries(INDICATOR_REGISTRY).map(([id, v]) => ({ id, kind: v.kind }));

async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    const { id, symbol } = req.query;
    if (!id || !symbol) return res.status(400).json({ error: 'Missing id or symbol' });

    const entry = INDICATOR_REGISTRY[id];
    if (!entry) return res.status(404).json({ error: `Unknown indicator id: ${id}` });

    if (!process.env.COINGLASS_API_KEY) {
        return res.status(503).json({ error: 'Coinglass API not configured on the server.' });
    }

    try {
        const fn = await entry.loader();
        // Most indicators expect the base symbol (e.g. "BTC") rather than the
        // full perpetual product.
        const cleanSymbol = String(symbol).toUpperCase().split('-')[0];
        const data = await fn(cleanSymbol);
        // Light edge cache so repeated chart redraws don't burn quota.
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
        return res.status(200).json({ id, symbol: cleanSymbol, kind: entry.kind, data });
    } catch (e) {
        console.error(`[COINGLASS] ${id} failed for ${symbol}:`, e.message);
        return res.status(502).json({ id, symbol, error: e.message });
    }
}

export default withTenantAuth(handler);
