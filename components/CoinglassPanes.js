// components/CoinglassPanes.js
import React, { useEffect, useState, useRef } from 'react';
import { createChart, CrosshairMode, AreaSeries, HistogramSeries } from 'lightweight-charts';

export default function CoinglassPanes({ chartRef, asset, indicators, token, timeframe }) {
  const [data, setData] = useState({}); // { [id]: { loading, data, error } }

  useEffect(() => {
    if (!asset || !token || !indicators?.length) return;
    let cancelled = false;

    const fetchOne = async (ind) => {
      setData(prev => ({ ...prev, [ind.id]: { ...(prev[ind.id] || {}), loading: true } }));
      try {
        const tfParam = timeframe ? `&interval=${encodeURIComponent(timeframe)}` : '';
        const res = await fetch(`/api/coinglass-indicator?id=${encodeURIComponent(ind.id)}&series=1&symbol=${encodeURIComponent(asset)}${tfParam}`,
          { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (!cancelled) {
          setData(prev => ({ ...prev, [ind.id]: { loading: false, data: json?.data, error: !res.ok ? (json?.error || `HTTP ${res.status}`) : null } }));
        }
      } catch (e) {
        if (!cancelled) {
          setData(prev => ({ ...prev, [ind.id]: { loading: false, error: e.message } }));
        }
      }
    };

    indicators.forEach(fetchOne);
    const interval = setInterval(() => indicators.forEach(fetchOne), 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [asset, token, indicators, timeframe]);

  if (!indicators?.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {indicators.map((ind) => (
        <PaneChart 
          key={`${ind.id}-${asset}-${timeframe}`} 
          chartRef={chartRef} 
          indicator={ind} 
          state={data[ind.id] || { loading: true }} 
        />
      ))}
    </div>
  );
}

function PaneChart({ chartRef, indicator, state }) {
  const containerRef = useRef(null);
  const paneChartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 120,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        visible: false, // hide time axis on subcharts
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      }
    });

    paneChartRef.current = chart;

    // Use histogram for volume-like indicators, area for others
    const isHistogram = indicator.id.includes('cvd') || indicator.id.includes('momentum') || indicator.id.includes('velocity');
    
    if (isHistogram) {
      seriesRef.current = chart.addSeries(HistogramSeries, {
        color: '#6366f1',
        priceFormat: { type: 'volume' },
      });
    } else {
      seriesRef.current = chart.addSeries(AreaSeries, {
        lineColor: '#38bdf8',
        topColor: 'rgba(56, 189, 248, 0.4)',
        bottomColor: 'rgba(56, 189, 248, 0.0)',
        lineWidth: 2,
      });
    }

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize(); // Initial sizing

    // --- Synchronization Logic ---
    const mainChart = chartRef?.current;
    
    // 🟢 ONE-WAY SYNC: Main chart → pane only.
    // Pane never syncs back to main chart. This prevents the zoom-out/reset loop.
    // Also defers sync until the pane actually has data (seriesRef.current is set).
    if (mainChart) {
      const syncMainToPane = () => {
        if (!seriesRef.current) return; // No data loaded yet — skip
        try {
          const logicalRange = mainChart.timeScale().getVisibleLogicalRange();
          if (logicalRange) chart.timeScale().setVisibleLogicalRange(logicalRange);
        } catch (e) {}
      };
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(syncMainToPane);
    }

    return () => {
      if (mainChart) {
        mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncMainToPane);
      }
      chart.remove();
      window.removeEventListener('resize', handleResize);
    };
  }, [chartRef, indicator.id]);

  useEffect(() => {
    if (state.data?.series && seriesRef.current) {
      const formattedData = state.data.series.map(s => {
        const val = Number(s.value);
        return {
          time: s.time,
          value: val,
          color: val >= 0 ? '#10b981' : '#ef4444'
        };
      }).sort((a, b) => a.time - b.time);
      
      const uniqueData = formattedData.filter((v, i, a) => a.findIndex(t => (t.time === v.time)) === i);
      
      try {
        // 🟢 Set data WITHOUT triggering chart auto-fit.
        // lightweight-charts can auto-adjust the time scale when new data
        // extends beyond the current range. We suppress this by using
        // setData only and never calling fitContent() or similar.
        seriesRef.current.setData(uniqueData);
        
        // After first data load, explicitly sync pane to main chart range
        const mainChart = chartRef?.current;
        if (mainChart && paneChartRef.current) {
          try {
            const logicalRange = mainChart.timeScale().getVisibleLogicalRange();
            if (logicalRange) {
              paneChartRef.current.timeScale().setVisibleLogicalRange(logicalRange);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.warn(`[CoinglassPanes] Could not set data for ${indicator.id}:`, e.message);
      }
    }
  }, [state.data]);

  return (
    <div className="bg-slate-900/40 border border-white/5 rounded-xl p-3 relative overflow-hidden group">
      <div className="absolute top-2 left-3 z-10 flex items-center gap-3">
        <span className="text-[10px] font-black uppercase tracking-widest text-white shadow-black drop-shadow-md">
          {indicator.label}
        </span>
        {state.loading && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />}
        {state.error && <span className="text-[9px] text-red-400 font-mono shadow-black drop-shadow-md">⚠️ {state.error}</span>}
      </div>
      <div ref={containerRef} className="w-full h-[120px]" />
    </div>
  );
}
