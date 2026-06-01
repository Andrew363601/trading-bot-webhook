// components/CoinglassHeatmap.js
// Liquidation HEATMAP overlay (legend.coinglass.com style — price-band variant).
//
// The Coinbase aggregated liquidation-map endpoint returns a PRICE-density
// distribution (no time axis), so we paint horizontal heat bands across the full
// chart width: brighter/redder = denser liquidation pool. Each band is anchored
// to its PRICE via series.priceToCoordinate(), so it tracks the candles on
// pan/zoom. Rendered on a translucent canvas BEHIND the candle wicks (low z so
// price action stays readable).
//
// Returns a <canvas>; mounts as a sibling of the chart container (absolute,
// inset-0). Only renders when the `liquidation_map` overlay is active.

import { useEffect, useRef, useCallback } from 'react';

// Blue (cold) -> green -> yellow -> red (hot). intensity in [0,1].
function heatColor(intensity, alpha = 0.5) {
  const i = Math.max(0, Math.min(1, intensity));
  // Piecewise gradient.
  let r, g, b;
  if (i < 0.25)      { r = 30;  g = 80 + i * 400;        b = 220; }      // blue -> cyan
  else if (i < 0.5)  { r = 30;  g = 200;                 b = 220 - (i - 0.25) * 700; } // cyan -> green
  else if (i < 0.75) { r = 30 + (i - 0.5) * 880; g = 220; b = 40; }      // green -> yellow
  else               { r = 250; g = 220 - (i - 0.75) * 720; b = 30; }    // yellow -> red
  return `rgba(${Math.round(r)}, ${Math.round(Math.max(0, g))}, ${Math.round(Math.max(0, b))}, ${alpha})`;
}

export default function CoinglassHeatmap({ chartRef, seriesRef, containerRef, asset, activeLiquidation, activeWalls, token, timeframe }) {
  const canvasRef = useRef(null);
  const dataRef = useRef({ mode: 'bands', bands: [], raster: null, walls: [] });
  const rafRef = useRef(null);

  // Fetch the data whenever the asset/timeframe toggles or activates.
  useEffect(() => {
    if ((!activeLiquidation && !activeWalls) || !asset || !token) { 
      dataRef.current = { mode: 'bands', bands: [], raster: null, walls: [] }; 
      scheduleDraw(); 
      return; 
    }
    let cancelled = false;
    (async () => {
      try {
        const tfParam = timeframe ? `&interval=${encodeURIComponent(timeframe)}` : '';
        const promises = [];

        if (activeLiquidation) {
          promises.push(fetch(`/api/coinglass-indicator?id=liquidation_map&heatmap=1&symbol=${encodeURIComponent(asset)}${tfParam}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()));
        } else {
          promises.push(Promise.resolve(null));
        }

        if (activeWalls) {
          promises.push(fetch(`/api/coinglass-indicator?id=large_limit_orders&symbol=${encodeURIComponent(asset)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()));
        } else {
          promises.push(Promise.resolve(null));
        }

        const [liqJson, wallJson] = await Promise.all(promises);
        if (cancelled) return;

        let mode = 'bands', raster = null, bands = [], walls = [];

        if (liqJson?.data) {
          const ldata = liqJson.data;
          if (ldata.mode === 'raster' && Array.isArray(ldata.cells) && ldata.cells.length) {
            mode = 'raster';
            raster = { times: ldata.times || [], prices: ldata.prices || [], cells: ldata.cells };
          } else {
            bands = Array.isArray(ldata.heatmap) ? ldata.heatmap : [];
          }
        }

        if (wallJson?.data?.valid_walls) {
          walls = wallJson.data.valid_walls;
        }

        dataRef.current = { mode, raster, bands, walls };
        scheduleDraw();
      } catch (_) { /* best-effort */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLiquidation, activeWalls, asset, token, timeframe]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const store = dataRef.current;
    if (!active || !seriesRef.current || !chartRef.current) return;

    const W = rect.width;

    // ---- RASTER MODE: true time x price liquidation heatmap ----
    if (store.mode === 'raster' && store.raster?.cells?.length) {
      const { times, prices, cells } = store.raster;
      const ts = chartRef.current.timeScale();
      const xs = times.map(t => { try { return ts.timeToCoordinate(t); } catch { return null; } });
      const ys = prices.map(p => { try { return seriesRef.current.priceToCoordinate(p); } catch { return null; } });
      const cellW = medianSpacing(xs) || (W / Math.max(1, times.length));
      const cellH = medianSpacing(ys) || 4;
      cells.forEach((c) => {
        const x = xs[c.x];
        const y = ys[c.y];
        if (x == null || y == null) return;
        ctx.fillStyle = heatColor(c.intensity, 0.15 + c.intensity * 0.6);
        ctx.fillRect(x - cellW / 2, y - cellH / 2, cellW + 1, cellH + 1);
      });
    } else {
      // ---- BANDS MODE: price-band fallback (no time axis) ----
      const pts = (store.bands || [])
        .map(p => ({ ...p, y: (() => { try { return seriesRef.current.priceToCoordinate(p.price); } catch { return null; } })() }))
        .filter(p => p.y != null)
        .sort((a, b) => a.y - b.y);

      if (pts.length) {
        const gaps = [];
        for (let i = 1; i < pts.length; i++) gaps.push(Math.abs(pts[i].y - pts[i - 1].y));
        gaps.sort((a, b) => a - b);
        const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 8;
        const bandH = Math.max(2, Math.min(18, medianGap || 8));

        pts.forEach((p) => {
          const alpha = 0.18 + p.intensity * 0.55;
          ctx.fillStyle = heatColor(p.intensity, alpha);
          ctx.fillRect(0, p.y - bandH / 2, W, bandH);
        });
      }
    }

    // ---- LARGE LIMIT ORDERS WALLS ----
    if (store.walls && store.walls.length) {
      const maxVal = Math.max(...store.walls.map(w => Number(w.valueUsd) || 0));
      store.walls.forEach(w => {
        const val = Number(w.valueUsd) || 0;
        if (val === 0) return;
        let y = null;
        try { y = seriesRef.current.priceToCoordinate(Number(w.price ?? w.level)); } catch {}
        if (y == null) return;
        
        const intensity = val / maxVal;
        // Determine color: Asks (Sell) = Red, Bids (Buy) = Green
        const isAsk = w.side && w.side.toLowerCase() === 'ask';
        const color = isAsk ? `rgba(239, 68, 68, ${0.4 + intensity * 0.5})` : `rgba(16, 185, 129, ${0.4 + intensity * 0.5})`;
        
        const blockHeight = 6 + (intensity * 10);
        // Extend backwards from the right edge based on size
        const blockWidth = 40 + (intensity * 120); 
        
        ctx.fillStyle = color;
        ctx.fillRect(W - blockWidth, y - blockHeight / 2, blockWidth, blockHeight);
        
        // Value label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`$${(val / 1000000).toFixed(1)}M`, W - 5, y + 3);
      });
    }

  }, [activeLiquidation, activeWalls, containerRef, seriesRef, chartRef]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // Redraw on pan/zoom/crosshair/resize.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = () => scheduleDraw();
    try { chart.timeScale().subscribeVisibleTimeRangeChange(onRange); } catch {}
    try { chart.timeScale().subscribeVisibleLogicalRangeChange(onRange); } catch {}
    try { chart.subscribeCrosshairMove(onRange); } catch {}
    const ro = new ResizeObserver(() => scheduleDraw());
    if (containerRef.current) ro.observe(containerRef.current);
    scheduleDraw();
    return () => {
      try { chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange); } catch {}
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch {}
      try { chart.unsubscribeCrosshairMove(onRange); } catch {}
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [chartRef, containerRef, scheduleDraw]);

  // Low z-index so the heatmap sits behind drawings/crosshair; pointer-events
  // off so it never blocks chart interaction.
  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-[5]"
      style={{ pointerEvents: 'none' }}
    />
  );
}

// Median absolute spacing between consecutive non-null coordinates — used to
// size raster cells so they tile without gaps regardless of zoom.
function medianSpacing(coords) {
  const valid = coords.filter(c => c != null);
  if (valid.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < valid.length; i++) {
    const g = Math.abs(valid[i] - valid[i - 1]);
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
