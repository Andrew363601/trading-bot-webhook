// components/ChartToolbar.js
// Compact toolbar for the live trading chart.
//   • Drawing tools: horizontal line, trend line, text note, clear.
//   • Coinglass indicator picker (legend.coinglass.com-style multi-select).
// All UI is stateless — the consumer (pages/index.js) owns state via props.

import React, { useEffect, useRef, useState } from 'react';
import {
  Minus, Slash, Type, Eraser, Sliders, X, ChevronDown,
  Square, MoveUpRight, GitCommitVertical, Spline, Undo2,
} from 'lucide-react';

// Preset palette for drawings.
const DRAW_COLORS = ['#6366f1', '#22d3ee', '#22c55e', '#f59e0b', '#ef4444', '#e2e8f0'];

// Display metadata for the Coinglass indicators exposed by /api/coinglass-indicator.
// `kind` MUST match what the API returns so the chart knows whether to render
// on top of the candles (overlay) or stacked below (pane).
export const COINGLASS_CATALOG = [
  { id: 'liquidation_map',      kind: 'overlay', label: 'Liquidation Heatmap' },
  { id: 'large_limit_orders',   kind: 'overlay', label: 'Large Limit Orders' },
  { id: 'orderbook_depth',      kind: 'overlay', label: 'Orderbook Depth Walls' },
  { id: 'funding_rate',         kind: 'pane',    label: 'Funding Rate' },
  { id: 'oi_momentum',          kind: 'pane',    label: 'Open Interest Momentum' },
  { id: 'spot_cvd_divergence',  kind: 'pane',    label: 'Spot CVD Divergence' },
  { id: 'long_short_sentiment', kind: 'pane',    label: 'Long/Short Sentiment' },
  { id: 'taker_buy_sell_ratio', kind: 'pane',    label: 'Taker Buy/Sell Ratio' },
  { id: 'liquidation_velocity', kind: 'pane',    label: 'Liquidation Velocity' },
  { id: 'orderbook_imbalance',  kind: 'pane',    label: 'Orderbook Imbalance' },
];

export default function ChartToolbar({
  drawingTool,            // null | 'hline' | 'vline' | 'tline' | 'ray' | 'rect' | 'fib' | 'brush' | 'text' | 'eraser'
  setDrawingTool,
  drawColor,              // active draw color (hex)
  setDrawColor,
  onUndo,                 // remove last drawing
  onClearDrawings,        // remove all drawings
  selectedIndicators,     // [{ id, kind, label }]
  toggleIndicator,
  isChartExpanded,        // when false on mobile, pane indicators are disabled
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const menuRef = useRef(null);
  const colorRef = useRef(null);

  // Click-outside dismiss for the indicator picker + color popover.
  useEffect(() => {
    if (!menuOpen && !colorOpen) return;
    const onClickAway = (e) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
      if (colorOpen && colorRef.current && !colorRef.current.contains(e.target)) setColorOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [menuOpen, colorOpen]);

  const toolBtn = (tool, Icon, label) => (
    <button
      key={tool}
      onClick={() => setDrawingTool(drawingTool === tool ? null : tool)}
      title={label}
      className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase transition-all flex items-center gap-1 ${
        drawingTool === tool
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
          : 'dark:bg-slate-800/50 bg-slate-200 dark:text-slate-400 text-slate-600 hover:text-slate-200 border dark:border-white/5 border-slate-300'
      }`}
    >
      <Icon size={11} />
    </button>
  );

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* Drawing tools */}
      <div className="flex items-center gap-1 dark:bg-black/40 bg-slate-200 p-1 rounded-xl border dark:border-white/5 border-slate-300">
        {toolBtn('hline', Minus, 'Horizontal Line — click to place')}
        {toolBtn('vline', GitCommitVertical, 'Vertical Line — click to place')}
        {toolBtn('tline', Slash, 'Trend Line — drag from start to end')}
        {toolBtn('ray', MoveUpRight, 'Ray — drag; extends to the right edge')}
        {toolBtn('rect', Square, 'Rectangle / Zone — drag to size')}
        {toolBtn('fib', Spline, 'Fibonacci Retracement — drag high to low')}
        {toolBtn('brush', Spline, 'Freehand Brush — press & drag')}
        {toolBtn('text', Type, 'Text Note — click to place')}
        {toolBtn('eraser', Eraser, 'Eraser — click a drawing to remove it')}

        {/* Color picker */}
        <div className="relative" ref={colorRef}>
          <button
            onClick={() => setColorOpen(v => !v)}
            title="Drawing color"
            className="w-6 h-6 rounded-lg border dark:border-white/10 border-slate-300 flex items-center justify-center"
            style={{ background: drawColor }}
          >
            <ChevronDown size={9} className="text-white/80 drop-shadow" />
          </button>
          {colorOpen && (
            <div
              className="absolute right-0 mt-2 p-2 rounded-xl bg-slate-950 border border-white/10 shadow-2xl z-[80] grid grid-cols-3 gap-1.5 pointer-events-auto"
              onMouseMove={(e) => e.stopPropagation()}
            >
              {DRAW_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => { setDrawColor(c); setColorOpen(false); }}
                  className={`w-6 h-6 rounded-md border ${drawColor === c ? 'border-white' : 'border-white/10'}`}
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          )}
        </div>

        <button
          onClick={onUndo}
          title="Undo last drawing"
          className="px-2 py-1 rounded-lg text-[9px] font-black uppercase dark:bg-slate-800/50 bg-slate-200 dark:text-slate-400 text-slate-600 hover:text-amber-400 border dark:border-white/5 border-slate-300"
        >
          <Undo2 size={11} />
        </button>
        <button
          onClick={onClearDrawings}
          title="Clear all drawings"
          className="px-2 py-1 rounded-lg text-[9px] font-black uppercase dark:bg-slate-800/50 bg-slate-200 dark:text-slate-400 text-slate-600 hover:text-red-400 border dark:border-white/5 border-slate-300"
        >
          <X size={11} />
        </button>
      </div>

      {/* Coinglass indicator picker */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(v => !v)}
          title="Coinglass indicators"
          className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase transition-all flex items-center gap-1 border ${
            selectedIndicators.length > 0
              ? 'bg-amber-600/30 text-amber-300 border-amber-500/40'
              : 'dark:bg-slate-800/50 bg-slate-200 dark:text-slate-400 text-slate-600 border dark:border-white/5 border-slate-300 hover:text-slate-200'
          }`}
        >
          <Sliders size={11} />
          Indicators
          {selectedIndicators.length > 0 && <span className="ml-0.5">({selectedIndicators.length})</span>}
          <ChevronDown size={10} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 mt-2 w-72 max-h-[400px] overflow-y-auto border border-white/10 rounded-2xl shadow-2xl z-[90] p-3 pointer-events-auto animate-in fade-in slide-in-from-top-2"
            // Fully opaque background + isolated stacking context so the candle
            // chart can never bleed THROUGH the menu, and pointer events here
            // don't fall through to the chart's crosshair handler underneath.
            style={{ backgroundColor: '#020617', isolation: 'isolate' }}
            onMouseMove={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/5">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Coinglass Indicators</span>
              <button onClick={() => setMenuOpen(false)} className="text-slate-500 hover:text-white"><X size={12} /></button>
            </div>
            {/* Overlays first, then panes. */}
            {['overlay', 'pane'].map((kind) => {
              const items = COINGLASS_CATALOG.filter(c => c.kind === kind);
              if (!items.length) return null;
              const heading = kind === 'overlay' ? 'On-Chart Overlays' : 'Stacked Panes';
              const helper = kind === 'overlay'
                ? 'Always visible (incl. mobile collapsed view).'
                : 'Stacked below the chart. Hidden on mobile when chart is collapsed.';
              return (
                <div key={kind} className="mb-3 last:mb-0">
                  <div className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1">{heading}</div>
                  <div className="text-[9px] text-slate-600 mb-2">{helper}</div>
                  <div className="flex flex-col gap-1">
                    {items.map((item) => {
                      const isSelected = selectedIndicators.some(s => s.id === item.id);
                      const disabled = kind === 'pane' && !isChartExpanded; // suggest user expand the chart first for panes on mobile
                      return (
                        <button
                          key={item.id}
                          onClick={() => toggleIndicator(item)}
                          disabled={disabled}
                          className={`text-left px-2.5 py-1.5 rounded-lg text-[10px] flex items-center justify-between border transition-colors ${
                            isSelected
                              ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-200'
                              : disabled
                                ? 'opacity-40 border-transparent text-slate-500 cursor-not-allowed'
                                : 'border-transparent text-slate-300 hover:bg-white/5 hover:border-white/10'
                          }`}
                        >
                          <span>{item.label}</span>
                          {isSelected && <span className="text-[8px] font-black uppercase tracking-widest text-indigo-400">ON</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
