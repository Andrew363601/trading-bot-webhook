// lib/coinglass_liquidation_heatmap_v4.js
// Time x Price liquidation HEATMAP source (legend.coinglass.com style).
//
// Coinglass exposes a dedicated heatmap "model" endpoint that returns a 2D grid
// of liquidation leverage density across BOTH time and price. We normalize it
// into { times[], prices[], cells:[{x,y,intensity}] } where x indexes `times`,
// y indexes `prices`, and intensity is 0..1. The front-end raster maps each cell
// to pixels via timeToCoordinate(times[x]) + priceToCoordinate(prices[y]).
//
// `interval` mirrors the chart's selected timeframe (1m/5m/15m/1h/6h/1d). If the
// model endpoint is unavailable (older plan/tier), we fall back to the snapshot
// aggregated-map so the overlay still renders as price bands.

import { coinglass_aggregated_liquidation_map_v4 } from './coinglass_aggregated_liquidation_map_v4.js';

const KEY = () => process.env.COINGLASS_API_KEY;
const HDRS = () => ({ accept: 'application/json', 'CG-API-KEY': KEY() });

export async function coinglass_liquidation_heatmap_v4(symbol, interval = '5m') {
  try {
    // Coinglass aggregated liquidation heatmap model (time x price grid).
    // range "3d" keeps payloads reasonable; the front-end only renders the
    // visible window anyway.
    const url = `https://open-api-v3.coinglass.com/api/futures/liquidation/aggregated-heatmap/model?symbol=${symbol}&interval=${interval}&range=3d`;
    const res = await fetch(url, { headers: HDRS() });
    if (res.ok) {
      const json = await res.json();
      const grid = normalizeModel(json?.data);
      if (grid && grid.cells.length) {
        return { status: 'success', mode: 'raster', interval, ...grid };
      }
    }
  } catch (_) { /* fall through to snapshot */ }

  // Fallback: price-band snapshot (no time axis).
  try {
    const snap = await coinglass_aggregated_liquidation_map_v4(symbol);
    if (snap.status === 'success') {
      return { status: 'success', mode: 'bands', interval, heatmap: snap.heatmap, current_price: snap.current_price };
    }
    return snap;
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// The model endpoint shape can vary; commonly:
//   { y: [priceLevels], data: [[xIndex, yIndex, value], ...] }  OR
//   { priceArray:[], timeArray:[], liqHeatMap:{ data:[[x,y,v]] } }
// Normalize defensively into { times[], prices[], cells:[{x,y,intensity}] }.
function normalizeModel(data) {
  if (!data) return null;

  const prices = data.y || data.priceArray || data.prices || [];
  const times =
    (data.x || data.timeArray || data.times || []).map(t => {
      const n = Number(t);
      return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n); // ms -> s
    });

  const raw =
    data.liquidationLeverage ||
    data.liqHeatMap?.data ||
    data.data ||
    data.heatmap ||
    [];

  if (!Array.isArray(raw) || !prices.length) return null;

  // Find max value to normalize intensity to 0..1.
  let maxV = 0;
  for (const c of raw) {
    const v = Array.isArray(c) ? Number(c[2]) : Number(c.value ?? c.v ?? 0);
    if (v > maxV) maxV = v;
  }
  if (maxV <= 0) return null;

  const cells = raw.map((c) => {
    if (Array.isArray(c)) {
      return { x: Number(c[0]), y: Number(c[1]), intensity: +(Number(c[2]) / maxV).toFixed(4) };
    }
    return { x: Number(c.x), y: Number(c.y), intensity: +(Number(c.value ?? c.v ?? 0) / maxV).toFixed(4) };
  }).filter(c => Number.isFinite(c.x) && Number.isFinite(c.y) && c.intensity > 0.02);

  return {
    times,
    prices: prices.map(Number),
    cells,
  };
}
