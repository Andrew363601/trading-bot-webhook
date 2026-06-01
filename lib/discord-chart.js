// lib/discord-chart.js

export async function buildRadarChartUrl({ asset, candles, poc, upperNode, lowerNode, currentPrice, trapPrice, trapSide, tpPrice, slPrice, openTrade }) {
    try {
        if (!candles || !Array.isArray(candles) || candles.length === 0) return null;

        // ... (rest of data prep)
        const recentCandles = candles.slice(-50);
        const labels = recentCandles.map((_, i) => i.toString());

        const annotations = [];
        const safeParse = (val) => {
            if (val === undefined || val === null || val === "None" || val === "Unavailable" || val === "EVALUATING") return null;
            const parsed = parseFloat(val);
            return isNaN(parsed) ? null : parsed;
        };

        const safeCurrentPrice = safeParse(currentPrice);
        const safePoc = safeParse(poc);
        const safeUpper = safeParse(upperNode);
        const safeLower = safeParse(lowerNode);
        const safeTrap = safeParse(trapPrice);
        const safeTp = safeParse(tpPrice || openTrade?.tp_price);
        const safeSl = safeParse(slPrice || openTrade?.sl_price);
        const safeEntry = safeParse(openTrade?.entry_price || currentPrice);

        // 1. Current Price Line (Blue Dashed)
        if (safeCurrentPrice !== null) {
            annotations.push({
                type: 'line', yMin: safeCurrentPrice, yMax: safeCurrentPrice,
                borderColor: 'rgba(56, 189, 248, 0.8)', borderWidth: 2, borderDash: [5, 5],
                label: { display: true, content: `PRICE: $${safeCurrentPrice}`, backgroundColor: 'rgba(56, 189, 248, 0.8)', font: { size: 10 } }
            });
        }

        // 2. Macro POC Line (Amber)
        if (safePoc !== null) {
            annotations.push({
                type: 'line', yMin: safePoc, yMax: safePoc,
                borderColor: 'rgba(245, 158, 11, 0.8)', borderWidth: 2,
                label: { display: true, content: 'MACRO POC', backgroundColor: 'rgba(245, 158, 11, 0.8)', font: { size: 10 } }
            });
        }

        // 3. Upper Node (Slate)
        if (safeUpper !== null) {
            annotations.push({
                type: 'line', yMin: safeUpper, yMax: safeUpper,
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { display: true, content: 'UPPER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', font: { size: 10 }, position: 'start' }
            });
        }

        // 4. Lower Node (Slate)
        if (safeLower !== null) {
            annotations.push({
                type: 'line', yMin: safeLower, yMax: safeLower,
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { display: true, content: 'LOWER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', font: { size: 10 }, position: 'start' }
            });
        }

        // 5. Active Trap Line (Green/Red)
        if (safeTrap !== null && trapSide) {
            const trapColor = trapSide === 'BUY' ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)';
            annotations.push({
                type: 'line', yMin: safeTrap, yMax: safeTrap,
                borderColor: trapColor, borderWidth: 2,
                label: { display: true, content: `TRAP: ${trapSide}`, backgroundColor: trapColor, font: { size: 10 }, position: 'end' }
            });
        }

        // 6. Open Trade Targets
        if (safeEntry !== null) {
            annotations.push({
                type: 'line', yMin: safeEntry, yMax: safeEntry,
                borderColor: 'rgba(255, 255, 255, 0.6)', borderWidth: 2, borderDash: [2, 2],
                label: { display: true, content: `ENTRY: $${safeEntry}`, backgroundColor: 'rgba(255, 255, 255, 0.2)', color: '#fff', font: { size: 10 }, position: 'start' }
            });
        }
        if (safeTp !== null) {
            annotations.push({
                type: 'line', yMin: safeTp, yMax: safeTp,
                borderColor: 'rgba(16, 185, 129, 0.8)', borderWidth: 1, borderDash: [4, 4],
                label: { display: true, content: `TP: $${safeTp}`, backgroundColor: 'rgba(16, 185, 129, 0.2)', color: '#10b981', font: { size: 10 }, position: 'start' }
            });
        }
        if (safeSl !== null) {
            annotations.push({
                type: 'line', yMin: safeSl, yMax: safeSl,
                borderColor: 'rgba(239, 68, 68, 0.8)', borderWidth: 1, borderDash: [4, 4],
                label: { display: true, content: `SL: $${safeSl}`, backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', font: { size: 10 }, position: 'start' }
            });
        }

        // 🪧 Build the Chart.js JSON configuration using candlestick.
        // We explicitly pass `version: "3"` to QuickChart in the payload below
        // so that it loads the necessary `chartjs-chart-financial` plugin.
        const candleData = recentCandles.map((c, i) => ({
            x: i,
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close
        }));

        const isUptrend = (candleData.length > 1 && candleData[candleData.length - 1].c >= candleData[0].o);

        const chartConfig = {
            type: 'candlestick',
            data: {
                datasets: [{
                    label: `${asset} (Last ${candleData.length} Candles)`,
                    data: candleData,
                    color: {
                        up: 'rgba(16, 185, 129, 1)',
                        down: 'rgba(239, 68, 68, 1)',
                        unchanged: 'rgba(148, 163, 184, 1)'
                    }
                }]
            },
            options: {
                plugins: {
                    legend: { labels: { color: '#94a3b8' } },
                    annotation: { annotations: annotations }
                },
                scales: {
                    x: { display: false, type: 'linear', position: 'bottom' },
                    y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        };

        const response = await fetch('https://quickchart.io/chart/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: "3",
                backgroundColor: "#020617",
                width: 600,
                height: 300,
                format: "png",
                chart: chartConfig
            })
        });

        if (!response.ok) {
            console.error("QuickChart API Error:", response.status, response.statusText);
            return null;
        }

        const responseData = await response.json();
        return responseData.url; 

    } catch (e) {
        console.error("Failed to generate radar chart URL:", e);
        return null;
    }
}