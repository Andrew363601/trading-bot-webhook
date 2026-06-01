// components/ChartDrawingLayer.js
// Robust, grid-anchored drawing engine for the live trading chart.
//
// Every drawing is stored as a set of { time, price } anchors — NEVER raw
// pixels. On each frame we project those anchors back to pixel coordinates via
// the chart's timeScale().timeToCoordinate() + series.priceToCoordinate(), so
// shapes stay glued to their candles when the user pans / zooms / scrolls.
//
// Supported tools:
//   • hline      — horizontal price line (1 anchor; infinite horizontal)
//   • vline      — vertical time line (1 anchor; infinite vertical)
//   • tline      — trend line segment (2 anchors)
//   • ray        — ray (2 anchors; extends past the 2nd point to the right edge)
//   • rect       — rectangle / zone (2 anchors = opposite corners)
//   • fib        — fibonacci retracement (2 anchors; horizontal levels between)
//   • brush      — freehand path (N anchors)
//   • text       — text note (1 anchor) — rendered as a DOM chip, anchored here too
//
// The component renders an absolutely-positioned <canvas> over the chart plus a
// thin DOM layer for text chips. It owns NO drawing state — the parent passes
// the drawings array + the in-progress draft so this stays a pure renderer with
// pointer plumbing.

import { useEffect, useRef, useCallback } from 'react';

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// Tools that require exactly two clicks (press = first anchor, release = second).
const TWO_POINT_TOOLS = new Set(['tline', 'ray', 'rect', 'fib']);
// Tools that need a single click.
const ONE_POINT_TOOLS = new Set(['hline', 'vline', 'text']);

export default function ChartDrawingLayer({
  chartRef,
  seriesRef,
  containerRef,
  drawingTool,          // active tool id or null
  drawColor,            // hex/rgba string for new drawings
  drawings,             // [{ id, type, points:[{time,price}], color, text? }]
  onCommitDrawing,      // (drawing) => void  — push a finished drawing
  onDeleteDrawing,      // (id) => void       — remove a drawing (eraser click)
  version,              // bump to force a redraw (live ticks, data reloads)
}) {
  const canvasRef = useRef(null);
  const draftRef = useRef(null);      // in-progress 2-point / brush drawing
  const isDrawingRef = useRef(false); // pointer currently down for a drag draw

  // ---- coordinate helpers -------------------------------------------------
  const toX = useCallback((time) => {
    try { return chartRef.current?.timeScale()?.timeToCoordinate(time); } catch { return null; }
  }, [chartRef]);
  const toY = useCallback((price) => {
    try { return seriesRef.current?.priceToCoordinate(price); } catch { return null; }
  }, [seriesRef]);
  const fromX = useCallback((x) => {
    try { return chartRef.current?.timeScale()?.coordinateToTime(x); } catch { return null; }
  }, [chartRef]);
  const fromY = useCallback((y) => {
    try { return seriesRef.current?.coordinateToPrice(y); } catch { return null; }
  }, [seriesRef]);

  // ---- the renderer -------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Resize backing store to match the container in device pixels (crisp lines).
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const W = rect.width;
    const H = rect.height;

    const renderOne = (d) => {
      const color = d.color || 'rgba(99,102,241,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.font = '11px ui-monospace, monospace';

      const pts = (d.points || []).map(p => ({ x: toX(p.time), y: toY(p.price), raw: p }));
      // Bail if anchors fall outside the rendered range (null coords).
      const valid = pts.filter(p => p.x != null && p.y != null);

      switch (d.type) {
        case 'hline': {
          const y = toY(d.points[0].price);
          if (y == null) return;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
          ctx.fillText(`${d.points[0].price.toFixed(2)}`, 4, y - 4);
          break;
        }
        case 'vline': {
          const x = toX(d.points[0].time);
          if (x == null) return;
          ctx.save(); ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
          ctx.restore();
          break;
        }
        case 'tline': {
          if (valid.length < 2) return;
          ctx.beginPath(); ctx.moveTo(valid[0].x, valid[0].y); ctx.lineTo(valid[1].x, valid[1].y); ctx.stroke();
          break;
        }
        case 'ray': {
          if (valid.length < 2) return;
          const [a, b] = valid;
          const dx = b.x - a.x, dy = b.y - a.y;
          // Extend to the right edge.
          const t = dx === 0 ? H : (W - a.x) / dx;
          const ex = a.x + dx * t;
          const ey = a.y + dy * t;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
          break;
        }
        case 'rect': {
          if (valid.length < 2) return;
          const x = Math.min(valid[0].x, valid[1].x);
          const y = Math.min(valid[0].y, valid[1].y);
          const w = Math.abs(valid[1].x - valid[0].x);
          const h = Math.abs(valid[1].y - valid[0].y);
          ctx.save();
          ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
          ctx.restore();
          break;
        }
        case 'fib': {
          if (d.points.length < 2) return;
          const p0 = d.points[0].price;
          const p1 = d.points[1].price;
          const x0 = toX(d.points[0].time);
          const x1 = toX(d.points[1].time);
          const left = Math.min(x0 ?? 0, x1 ?? W);
          const right = Math.max(x0 ?? 0, x1 ?? W);
          FIB_LEVELS.forEach((lvl) => {
            const price = p0 + (p1 - p0) * lvl;
            const y = toY(price);
            if (y == null) return;
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.setLineDash(lvl === 0 || lvl === 1 ? [] : [3, 3]);
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
            ctx.restore();
            ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${price.toFixed(2)}`, left + 4, y - 3);
          });
          break;
        }
        case 'brush': {
          if (valid.length < 2) return;
          ctx.beginPath();
          ctx.moveTo(valid[0].x, valid[0].y);
          valid.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();
          break;
        }
        default:
          break;
      }
    };

    (drawings || []).forEach(renderOne);
    if (draftRef.current) renderOne(draftRef.current);
  }, [drawings, containerRef, toX, toY]);

  // Redraw on every chart pan/zoom/crosshair + on external version bumps.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = () => draw();
    try { chart.timeScale().subscribeVisibleTimeRangeChange(onRange); } catch {}
    try { chart.timeScale().subscribeVisibleLogicalRangeChange(onRange); } catch {}
    try { chart.subscribeCrosshairMove(onRange); } catch {}
    const ro = new ResizeObserver(() => draw());
    if (containerRef.current) ro.observe(containerRef.current);
    draw();
    return () => {
      try { chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange); } catch {}
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch {}
      try { chart.unsubscribeCrosshairMove(onRange); } catch {}
      ro.disconnect();
    };
  }, [chartRef, containerRef, draw]);

  useEffect(() => { draw(); }, [draw, version, drawColor]);

  // ---- pointer plumbing ---------------------------------------------------
  const eventToAnchor = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = fromX(x);
    const price = fromY(y);
    if (time == null || price == null) return null;
    return { time, price };
  }, [containerRef, fromX, fromY]);

  const handlePointerDown = useCallback((e) => {
    if (!drawingTool) return;

    // Eraser: delete the nearest drawing within a tolerance.
    if (drawingTool === 'eraser') {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let best = null; let bestDist = 14; // px tolerance
      (drawings || []).forEach((d) => {
        (d.points || []).forEach((p) => {
          const x = toX(p.time); const y = toY(p.price);
          if (x == null || y == null) return;
          const dist = Math.hypot(x - px, y - py);
          if (dist < bestDist) { bestDist = dist; best = d; }
        });
        // Also hit-test horizontal lines along their whole width.
        if (d.type === 'hline') {
          const y = toY(d.points[0].price);
          if (y != null && Math.abs(y - py) < bestDist) { bestDist = Math.abs(y - py); best = d; }
        }
      });
      if (best) onDeleteDrawing?.(best.id);
      return;
    }

    const anchor = eventToAnchor(e);
    if (!anchor) return;

    if (drawingTool === 'text') {
      const text = window.prompt('Note text:', '');
      if (text) onCommitDrawing?.({ id: genId(), type: 'text', points: [anchor], color: drawColor, text });
      return;
    }

    if (ONE_POINT_TOOLS.has(drawingTool)) {
      onCommitDrawing?.({ id: genId(), type: drawingTool, points: [anchor], color: drawColor });
      return;
    }

    if (drawingTool === 'brush') {
      isDrawingRef.current = true;
      draftRef.current = { id: genId(), type: 'brush', points: [anchor], color: drawColor };
      draw();
      return;
    }

    if (TWO_POINT_TOOLS.has(drawingTool)) {
      isDrawingRef.current = true;
      draftRef.current = { id: genId(), type: drawingTool, points: [anchor, anchor], color: drawColor };
      draw();
    }
  }, [drawingTool, drawColor, drawings, eventToAnchor, onCommitDrawing, onDeleteDrawing, draw, toX, toY, containerRef]);

  const handlePointerMove = useCallback((e) => {
    if (!isDrawingRef.current || !draftRef.current) return;
    const anchor = eventToAnchor(e);
    if (!anchor) return;
    if (draftRef.current.type === 'brush') {
      draftRef.current.points.push(anchor);
    } else {
      draftRef.current.points[1] = anchor;
    }
    draw();
  }, [eventToAnchor, draw]);

  const handlePointerUp = useCallback(() => {
    if (!isDrawingRef.current || !draftRef.current) return;
    isDrawingRef.current = false;
    const finished = draftRef.current;
    draftRef.current = null;
    // Discard degenerate drags (single point).
    if (finished.type !== 'brush' && finished.points.length === 2 &&
        finished.points[0].time === finished.points[1].time &&
        finished.points[0].price === finished.points[1].price) {
      draw();
      return;
    }
    onCommitDrawing?.(finished);
    draw();
  }, [onCommitDrawing, draw]);

  // The canvas only intercepts pointer events while a tool is active, so the
  // chart's own pan/zoom/crosshair stays fully usable otherwise.
  const active = !!drawingTool;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-20"
        style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
      {/* Text chips, anchored to time/price like everything else. */}
      {(drawings || []).filter(d => d.type === 'text').map((d) => {
        const x = toX(d.points[0].time);
        const y = toY(d.points[0].price);
        if (x == null || y == null) return null;
        return (
          <div
            key={d.id}
            className="absolute z-30 pointer-events-none px-2 py-0.5 rounded text-white text-[10px] font-bold shadow-lg"
            style={{ left: x, top: y, transform: 'translate(-2px, -50%)', background: d.color || 'rgba(99,102,241,0.85)' }}
          >
            {d.text}
          </div>
        );
      })}
    </>
  );
}

function genId() {
  return `dw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
