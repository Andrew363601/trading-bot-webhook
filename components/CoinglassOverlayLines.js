// components/CoinglassOverlayLines.js
// Renders Coinglass "overlay" indicators directly on top of the candle chart
// using lightweight-charts price lines. Mounts as a side-effect component (no
// JSX output) so it can hook into the chart's existing series ref.
//
// On mobile this stays mounted regardless of expand state (per spec: overlays
// must remain visible when the user collapses the chart) — the parent decides
// whether to render us; the chart series itself is always alive.

import { useEffect, useRef } from 'react';

const OVERLAY_COLORS = {
  liquidation_map: 'rgba(245, 158, 11, 0.8)',     // amber
  large_limit_orders: 'rgba(99, 102, 241, 0.8)',  // indigo
  orderbook_depth: 'rgba(34, 197, 94, 0.8)',      // emerald
};

export default function CoinglassOverlayLines({ seriesRef, asset, indicators, token }) {
  // Track price lines we've created so we can clean them up cleanly when the
  // user disables an indicator or switches asset/timeframe.
  const linesByIndicatorRef = useRef({}); // { [id]: PriceLine[] }

  // Clear ALL of our overlay lines (used on asset change / unmount).
  const clearAll = () => {
    if (!seriesRef?.current) return;
    Object.values(linesByIndicatorRef.current).flat().forEach(line => {
      try { seriesRef.current.removePriceLine(line); } catch (_) {}
    });
    linesByIndicatorRef.current = {};
  };

  // Wipe everything whenever the chart asset changes — those levels were for
  // the previous market and would otherwise mislead the user.
  useEffect(() => {
    clearAll();
    return () => clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  // Sync the set of active overlays against the indicators prop.
  useEffect(() => {
    if (!seriesRef?.current || !token || !asset || !indicators) return;
    let cancelled = false;

    // Remove lines for any indicator the user just disabled.
    const activeIds = new Set(indicators.map(i => i.id));
    Object.keys(linesByIndicatorRef.current).forEach(id => {
      if (!activeIds.has(id)) {
        (linesByIndicatorRef.current[id] || []).forEach(line => {
          try { seriesRef.current.removePriceLine(line); } catch (_) {}
        });
        delete linesByIndicatorRef.current[id];
      }
    });

    // Fetch + render each active overlay.
    indicators.forEach(async (ind) => {
      try {
        const res = await fetch(`/api/coinglass-indicator?id=${encodeURIComponent(ind.id)}&symbol=${encodeURIComponent(asset)}`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const { data } = await res.json();
        if (cancelled || !seriesRef.current) return;

        // Drop the previous render for this indicator before adding the new one.
        (linesByIndicatorRef.current[ind.id] || []).forEach(line => {
          try { seriesRef.current.removePriceLine(line); } catch (_) {}
        });
        linesByIndicatorRef.current[ind.id] = [];

        const color = OVERLAY_COLORS[ind.id] || 'rgba(148, 163, 184, 0.7)';
        const prices = extractPriceLevels(ind.id, data);
        prices.slice(0, 10).forEach((lvl) => {
          const line = seriesRef.current.createPriceLine({
            price: lvl.price,
            color,
            lineWidth: 1,
            lineStyle: 2, // dotted
            axisLabelVisible: true,
            title: lvl.label || ind.label,
          });
          linesByIndicatorRef.current[ind.id].push(line);
        });
      } catch (_) {
        // Silent fail — overlay is best-effort.
      }
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, token, indicators]);

  // No DOM output — this component just side-effects on the chart series.
  return null;
}

// Pull a list of { price, label } points out of each indicator's payload.
// We only need to know the *price levels* to draw — the visual is identical to
// horizontal price markers on the chart.
function extractPriceLevels(id, data) {
  if (!data) return [];

  switch (id) {
    case 'liquidation_map': {
      // coinglass_aggregated_liquidation_map_v4 returns { high_density_pools: [{ price, volume, side, ... }] }
      const pools = data.high_density_pools || [];
      return pools.map(p => ({
        price: parseFloat(p.price),
        label: p.side ? `Liq ${p.side}` : 'Liq Pool',
      })).filter(p => Number.isFinite(p.price));
    }
    case 'large_limit_orders': {
      // Walls are typically returned as orders[] with price + size + side.
      const orders = data.orders || data.walls || [];
      return orders.map(o => ({
        price: parseFloat(o.price ?? o.level),
        label: `Wall ${o.side || ''}`.trim(),
      })).filter(p => Number.isFinite(p.price));
    }
    case 'orderbook_depth': {
      // Top imbalance levels.
      const levels = data.levels || data.depth || [];
      return levels.map(l => ({
        price: parseFloat(l.price),
        label: l.side ? `Depth ${l.side}` : 'Depth',
      })).filter(p => Number.isFinite(p.price));
    }
    default:
      return [];
  }
}
