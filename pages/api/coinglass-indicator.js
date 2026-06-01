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
// `series: true`  => the loader accepts an `interval` (chart timeframe) and
//                    returns a raw `series[]` array we can render as a heat strip.
// `heatmap: true` => liquidation supports a time x price raster via a separate loader.
const INDICATOR_REGISTRY = {
    liquidation_map:           { kind: 'overlay', heatmap: true, loader: () => import('../../lib/coinglass_aggregated_liquidation_map_v4.js').then(m => m.coinglass_aggregated_liquidation_map_v4), heatmapLoader: () => import('../../lib/coinglass_liquidation_heatmap_v4.js').then(m => m.coinglass_liquidation_heatmap_v4) },
    large_limit_orders:        { kind: 'overlay', loader: () => import('../../lib/coinglass_large_limit_order_tracker_v4.js').then(m => m.coinglass_large_limit_order_tracker_v4) },
    orderbook_depth:           { kind: 'overlay', loader: () => import('../../lib/coinglass_aggregated_orderbook_depth_v4.js').then(m => m.coinglass_aggregated_orderbook_depth_v4) },
    funding_rate:              { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_funding_rate_reversion_v4.js').then(m => m.coinglass_funding_rate_reversion_v4) },
    oi_momentum:               { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_oi_momentum_v4.js').then(m => m.coinglass_oi_momentum_v4) },
    spot_cvd_divergence:       { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_spot_cvd_divergence_v4.js').then(m => m.coinglass_spot_cvd_divergence_v4) },
    long_short_sentiment:      { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_global_long_short_sentiment_v4.js').then(m => m.coinglass_global_long_short_sentiment_v4) },
    taker_buy_sell_ratio:      { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_taker_buy_sell_ratio_v4.js').then(m => m.coinglass_taker_buy_sell_ratio_v4) },
    liquidation_velocity:      { kind: 'pane', series: true, loader: () => import('../../lib/coinglass_pair_liquidation_velocity_v4.js').then(m => m.coinglass_pair_liquidation_velocity_v4) },
    orderbook_imbalance:       { kind: 'pane',    loader: () => import('../../lib/coinglass_orderbook_depth_imbalance_v4.js').then(m => m.coinglass_orderbook_depth_imbalance_v4) },
};

// Coinglass accepts these interval tokens; map any chart timeframe to a valid one.
const VALID_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h', '6h', '12h', '1d']);
function safeInterval(tf) {
    if (!tf) return undefined;
    return VALID_INTERVALS.has(String(tf)) ? String(tf) : undefined;
}

export const INDICATOR_CATALOG = Object.entries(INDICATOR_REGISTRY).map(([id, v]) => ({ id, kind: v.kind }));

// Coinbase dated-future / perp first-segment codes → canonical base ticker.
const FUTURES_CODE_MAP = {
    BIT: 'BTC', BIP: 'BTC',
    ETP: 'ETH',
    SLP: 'SOL',
    DOP: 'DOGE',
    LCP: 'LTC',
    AVP: 'AVAX',
    LNP: 'LINK',
    XPP: 'XRP',
};

// Turn any product id (BTC, BTC-USD, BTC-PERP-INTX, BIP-20DEC30-CDE, …) into a
// clean Coinglass base ticker (BTC, ETH, …).
function normalizeBaseTicker(symbol) {
    let base = String(symbol || '').toUpperCase().trim();
    // Strip known perp/quote/expiry suffixes.
    base = base.replace(/(-PERP-INTX|-PERP|-INTX|-CDE|-USDT|-USDC|-USD)/g, '');
    // Take the leading segment (handles dated futures like BIP-20DEC30).
    base = base.split('-')[0];
    return FUTURES_CODE_MAP[base] || base;
}

async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    const { id, symbol, interval: rawInterval, heatmap, series } = req.query;
    if (!id || !symbol) return res.status(400).json({ error: 'Missing id or symbol' });

    const entry = INDICATOR_REGISTRY[id];
    if (!entry) return res.status(404).json({ error: `Unknown indicator id: ${id}` });

    if (!process.env.COINGLASS_API_KEY) {
        return res.status(503).json({ error: 'Coinglass API not configured on the server.' });
    }

    // The chart passes its selected timeframe; map it to a valid Coinglass interval.
    const interval = safeInterval(rawInterval);

    try {
        // Most indicators expect the BASE symbol (e.g. "BTC") rather than the
        // full perpetual / dated-future product. Coinbase futures encode the
        // base into the first segment using non-standard codes (e.g. BIT/BIP =
        // BTC, ETP = ETH), so a naive `.split('-')[0]` on `BIP-20DEC30-CDE`
        // would wrongly ask Coinglass for "BIP". Normalize the known codes and
        // strip the standard perp/quote suffixes before calling the indicator.
        const cleanSymbol = normalizeBaseTicker(symbol);

        // 1) Time x price liquidation RASTER (when requested + supported).
        if (heatmap === '1' && entry.heatmap && entry.heatmapLoader) {
            const hfn = await entry.heatmapLoader();
            const data = await hfn(cleanSymbol, interval || '5m');
            res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
            return res.status(200).json({ id, symbol: cleanSymbol, kind: 'heatmap', data });
        }

        // 2) Standard indicator. Pass interval to series-capable loaders so the
        //    returned series[] aligns to the chart timeframe.
        const fn = await entry.loader();
        const data = entry.series
            ? await fn(cleanSymbol, undefined, interval)
            : await fn(cleanSymbol);

        // When the caller only wants the raw series (heat strips), trim the payload.
        const payload = (series === '1' && entry.series) ? { series: data?.series || [] } : data;

        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
        return res.status(200).json({ id, symbol: cleanSymbol, kind: entry.kind, interval: interval || null, data: payload });
    } catch (e) {
        console.error(`[COINGLASS] ${id} failed for ${symbol}:`, e.message);
        return res.status(502).json({ id, symbol, error: e.message });
    }
}

export default withTenantAuth(handler);
