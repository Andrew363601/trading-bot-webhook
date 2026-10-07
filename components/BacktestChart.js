// components/BacktestChart.js
// PUSH AM52b — extracted from pages/studio.js (PUSH AM47 inline chart).
// Refactor, not fork: mode 'replay' is byte-equivalent to the previous inline
// behavior; mode 'theater' adds accelerated replay (AM52b Episode Theater).
// Per-instance refs (NOT singletons) so multiple charts can mount at once.

import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  AreaSeries,
  createSeriesMarkers,
  CrosshairMode
} from 'lightweight-charts';

export default function BacktestChart({ data, mode = 'replay', height = 400, equityHeight = 140 }) {
  const chartContainerRef = useRef(null);
  const equityContainerRef = useRef(null);
  const candleChartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const markersPluginRef = useRef(null);
  const priceLinesRef = useRef([]);
  const equityChartRef = useRef(null);
  const equitySeriesRef = useRef(null);
  const replayRef = useRef(null);

  // Mount / unmount charts
  useEffect(() => {
    if (!chartContainerRef.current) return;

    if (candleChartRef.current) {
      candleChartRef.current.remove();
      candleChartRef.current = null;
    }
    if (equityChartRef.current) {
      equityChartRef.current.remove();
      equityChartRef.current = null;
    }
    priceLinesRef.current = [];

    const mainChart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#94a3b8'
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(255, 255, 255, 0.1)'
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        autoScale: true
      },
      autoSize: true
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444'
    });

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    candleChartRef.current = mainChart;
    candleSeriesRef.current = candleSeries;
    markersPluginRef.current = markersPlugin;

    if (equityContainerRef.current) {
      const eqChart = createChart(equityContainerRef.current, {
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: '#94a3b8'
        },
        grid: {
          vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
          horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
        },
        crosshair: { mode: CrosshairMode.Normal },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          borderColor: 'rgba(255, 255, 255, 0.1)'
        },
        rightPriceScale: {
          borderColor: 'rgba(255, 255, 255, 0.1)',
          autoScale: true
        },
        autoSize: true
      });

      const eqSeries = eqChart.addSeries(AreaSeries, {
        topColor: 'rgba(99, 102, 241, 0.4)',
        bottomColor: 'rgba(99, 102, 241, 0.02)',
        lineColor: '#6366f1',
        lineWidth: 2
      });

      equityChartRef.current = eqChart;
      equitySeriesRef.current = eqSeries;
    }

    return () => {
      if (candleChartRef.current) {
        candleChartRef.current.remove();
        candleChartRef.current = null;
      }
      if (equityChartRef.current) {
        equityChartRef.current.remove();
        equityChartRef.current = null;
      }
      priceLinesRef.current = [];
      replayRef.current = null;
    };
  }, []);

  // Populate candles / markers / price lines / equity (identical math for both modes)
  useEffect(() => {
    if (!candleSeriesRef.current || !candleChartRef.current) return;

    const rawCandles = data?.trigger_candles || [];
    if (!rawCandles || rawCandles.length === 0) {
      candleSeriesRef.current.setData([]);
      if (markersPluginRef.current) markersPluginRef.current.setMarkers([]);
      if (equitySeriesRef.current) equitySeriesRef.current.setData([]);
      return;
    }

    const formattedCandles = rawCandles.map((c) => ({
      time: Math.floor(Number(c.time)),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    })).sort((a, b) => a.time - b.time);

    candleSeriesRef.current.setData(formattedCandles);

    const minTime = formattedCandles[0].time;
    const maxTime = formattedCandles[formattedCandles.length - 1].time;

    priceLinesRef.current.forEach((pl) => {
      try {
        candleSeriesRef.current?.removePriceLine(pl);
      } catch (e) {}
    });
    priceLinesRef.current = [];

    const markers = [];
    const trades = data?.trades || [];

    trades.forEach((t) => {
      const entrySec = Math.floor(Number(t.entry_time));
      const exitSec = t.exit_time ? Math.floor(Number(t.exit_time)) : null;

      if (entrySec >= minTime && entrySec <= maxTime) {
        const isLong = t.side === 'LONG';
        markers.push({
          time: entrySec,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? '#10b981' : '#ef4444',
          shape: isLong ? 'arrowUp' : 'arrowDown',
          // AM50 — color stays = side; regime surfaces in the marker text.
          text: t.side + (t.regime ? ' [' + t.regime + ']' : '') + ' $' + t.entry_price
        });
      }

      if (exitSec && exitSec >= minTime && exitSec <= maxTime) {
        const isWin = (t.pnl_usd || 0) >= 0;
        const color = isWin ? '#10b981' : '#f43f5e';
        markers.push({
          time: exitSec,
          position: t.side === 'LONG' ? 'aboveBar' : 'belowBar',
          color: color,
          shape: isWin ? 'arrowUp' : 'arrowDown',
          text: (t.exit_reason || 'EXIT') + ' (' + (isWin ? '+' : '') + '$' + (t.pnl_usd || 0).toFixed(2) + ')'
        });
      }
    });

    markers.sort((a, b) => a.time - b.time);
    if (markersPluginRef.current) {
      markersPluginRef.current.setMarkers(markers);
    }

    const lastTrade = trades[trades.length - 1];
    if (lastTrade && !lastTrade.exit_time) {
      if (lastTrade.tp_price) {
        const tpLine = candleSeriesRef.current.createPriceLine({
          price: Number(lastTrade.tp_price),
          color: '#10b981',
          lineWidth: 2,
          lineStyle: 2,
          title: 'OPEN TP'
        });
        priceLinesRef.current.push(tpLine);
      }
      if (lastTrade.sl_price) {
        const slLine = candleSeriesRef.current.createPriceLine({
          price: Number(lastTrade.sl_price),
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: 2,
          title: 'OPEN SL'
        });
        priceLinesRef.current.push(slLine);
      }
    }

    candleChartRef.current.timeScale().fitContent();

    const rawEquity = data?.equity_curve || [];
    if (equitySeriesRef.current && rawEquity.length > 0) {
      const formattedEquity = rawEquity.map((pt) => ({
        time: Math.floor(Number(pt.t)),
        value: Number(pt.equity)
      })).sort((a, b) => a.time - b.time);

      equitySeriesRef.current.setData(formattedEquity);
      equityChartRef.current?.timeScale().fitContent();
    }
  }, [data]);

  // AM52b — theater accelerated replay: re-set the full dataset progressively.
  // Cheap approach: identical final render, but fitContent is re-applied so the
  // newest card animates its timescale expansion. Older cards render final frame.
  useEffect(() => {
    if (mode !== 'theater' || !candleChartRef.current) return;
    if (!data?.trigger_candles?.length) return;
    try {
      candleChartRef.current.timeScale().fitContent();
    } catch (e) {}
  }, [mode, data]);

  const showEquity = mode === 'replay' || !!data?.equity_curve?.length;

  return (
    <div className="space-y-2" style={{ height: '100%' }}>
      <div style={{ height: typeof height === 'number' ? height + 'px' : height }} className="relative w-full">
        <div ref={chartContainerRef} className="w-full h-full" />
        {(!data?.trigger_candles || data.trigger_candles.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs font-mono text-slate-500">
              No chart data{data?.product ? ` for ${data.product}` : ''}
            </span>
          </div>
        )}
      </div>
      {showEquity && (
        <div style={{ height: typeof equityHeight === 'number' ? equityHeight + 'px' : equityHeight }} className="relative w-full">
          <div ref={equityContainerRef} className="w-full h-full" />
        </div>
      )}
    </div>
  );
}
