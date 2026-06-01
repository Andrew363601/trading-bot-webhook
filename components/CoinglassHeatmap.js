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

export default function CoinglassHeatmap({ chartRef, seriesRef, containerRef, asset, active, token }) {
  const canvasRef = useRef(null);
  const dataRef = useRef([]);    // [{ price, intensity, side }]
  const rafRef = useRef(null);

  // Fetch the liquidation density grid whenever the asset toggles / activates.
  useEffect(() => {
    if (!active || !asset || !token) { dataRef.current = []; scheduleDraw(); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/coinglass-indicator?id=liquidation_map&symbol=${encodeURIComponent(asset)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) return;
        const { data } = await res.json();
        if (cancelled) return;
        dataRef.current = Array.isArray(data?.heatmap) ? data.heatmap : [];
        scheduleDraw();
      } catch (_) { /* best-effort */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, asset, token]);

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

    if (!active || !dataRef.current.length || !seriesRef.current) return;

    const W = rect.width;
    // Sort by price so we can size each band to the gap to its neighbour.
    const pts = dataRef.current
      .map(p => ({ ...p, y: (() => { try { return seriesRef.current.priceToCoordinate(p.price); } catch { return null; } })() }))
      .filter(p => p.y != null)
      .sort((a, b) => a.y - b.y);

    if (!pts.length) return;

    // Estimate a band thickness from the median spacing between adjacent levels.
    const gaps = [];
    for (let i = 1; i < pts.length; i++) gaps.push(Math.abs(pts[i].y - pts[i - 1].y));
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 8;
    const bandH = Math.max(2, Math.min(18, medianGap || 8));

    pts.forEach((p) => {
      // Tint by side: longs (support, below) lean green, shorts (resistance) lean red,
      // but intensity still drives brightness so the densest pools pop.
      const alpha = 0.18 + p.intensity * 0.55;
      ctx.fillStyle = heatColor(p.intensity, alpha);
      ctx.fillRect(0, p.y - bandH / 2, W, bandH);
    });
  }, [active, containerRef, seriesRef]);

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
