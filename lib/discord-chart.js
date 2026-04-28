// lib/discord-chart.js

export async function buildRadarChartUrl({ asset, candles, poc, upperNode, lowerNode, currentPrice, trapPrice, trapSide, openTrade }) {
    try {
        if (!candles || !Array.isArray(candles) || candles.length === 0) return null;

        // Grab the last 50 candles
        const recentCandles = candles.slice(-50);
        const labels = recentCandles.map((_, i) => i.toString());
        
        // Mapping Open, High, Low, and Close for the Candlestick engine
        const data = recentCandles.map((c, i) => ({
            x: i.toString(),
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close
        }));

        const annotations = [];

        // 🟢 THE FIX: Bulletproof number parsing to prevent QuickChart from crashing on NaN
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

        // 1. Current Price Line (Blue Dashed)
        if (safeCurrentPrice !== null) {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeCurrentPrice,
                borderColor: 'rgba(56, 189, 248, 0.8)', borderWidth: 2, borderDash: [5, 5],
                label: { enabled: true, content: `PRICE: $${safeCurrentPrice}`, backgroundColor: 'rgba(56, 189, 248, 0.8)', fontSize: 10 }
            });
        }

        // 2. Macro POC Line (Amber)
        if (safePoc !== null) {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safePoc,
                borderColor: 'rgba(245, 158, 11, 0.8)', borderWidth: 2,
                label: { enabled: true, content: 'MACRO POC', backgroundColor: 'rgba(245, 158, 11, 0.8)', fontSize: 10 }
            });
        }

        // 3. Upper Node (Slate)
        if (safeUpper !== null) {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeUpper,
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { enabled: true, content: 'UPPER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', fontSize: 10, position: 'left' }
            });
        }

        // 4. Lower Node (Slate)
        if (safeLower !== null) {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeLower,
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { enabled: true, content: 'LOWER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', fontSize: 10, position: 'left' }
            });
        }

        // 5. Active Trap Line (Green/Red)
        if (safeTrap !== null && trapSide) {
            const trapColor = trapSide === 'BUY' ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)';
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeTrap,
                borderColor: trapColor, borderWidth: 2,
                label: { enabled: true, content: `TRAP: ${trapSide}`, backgroundColor: trapColor, fontSize: 10, position: 'right' }
            });
        }

        // 6. Open Trade Targets
        if (openTrade) {
            const safeEntry = safeParse(openTrade.entry_price);
            const safeTp = safeParse(openTrade.tp_price);
            const safeSl = safeParse(openTrade.sl_price);

            if (safeEntry !== null) {
                annotations.push({
                    type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeEntry,
                    borderColor: 'rgba(255, 255, 255, 0.6)', borderWidth: 2, borderDash: [2, 2],
                    label: { enabled: true, content: `ENTRY: $${safeEntry}`, backgroundColor: 'rgba(255, 255, 255, 0.2)', fontColor: '#fff', fontSize: 10, position: 'left' }
                });
            }
            if (safeTp !== null) {
                annotations.push({
                    type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeTp,
                    borderColor: 'rgba(16, 185, 129, 0.8)', borderWidth: 1, borderDash: [4, 4],
                    label: { enabled: true, content: `TP: $${safeTp}`, backgroundColor: 'rgba(16, 185, 129, 0.2)', fontColor: '#10b981', fontSize: 10, position: 'left' }
                });
            }
            if (safeSl !== null) {
                annotations.push({
                    type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: safeSl,
                    borderColor: 'rgba(239, 68, 68, 0.8)', borderWidth: 1, borderDash: [4, 4],
                    label: { enabled: true, content: `SL: $${safeSl}`, backgroundColor: 'rgba(239, 68, 68, 0.2)', fontColor: '#ef4444', fontSize: 10, position: 'left' }
                });
            }
        }

        // Build the Chart.js JSON configuration
        const chartConfig = {
            type: 'candlestick',
            data: {
                labels: labels,
                datasets: [{
                    label: `${asset} (Last 50 Ticks)`,
                    data: data,
                    color: {
                        up: 'rgba(16, 185, 129, 0.8)',   
                        down: 'rgba(239, 68, 68, 0.8)',  
                        unchanged: 'rgba(148, 163, 184, 0.8)' 
                    },
                    borderColor: {
                        up: 'rgba(16, 185, 129, 1)',
                        down: 'rgba(239, 68, 68, 1)',
                        unchanged: 'rgba(148, 163, 184, 1)'
                    },
                    borderWidth: 1
                }]
            },
            options: {
                legend: { labels: { fontColor: '#94a3b8' } },
                scales: {
                    xAxes: [{ display: false }],
                    yAxes: [{ id: 'y-axis-0', ticks: { fontColor: '#94a3b8' }, gridLines: { color: 'rgba(255,255,255,0.05)' } }]
                },
                annotation: { annotations: annotations }
            }
        };

        const response = await fetch('https://quickchart.io/chart/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
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