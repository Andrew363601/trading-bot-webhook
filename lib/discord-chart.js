// lib/discord-chart.js

export async function buildRadarChartUrl({ asset, candles, poc, upperNode, lowerNode, currentPrice, trapPrice, trapSide }) {
    try {
        if (!candles || candles.length === 0) return null;

        // Grab the last 50 candles
        const recentCandles = candles.slice(-50);
        const labels = recentCandles.map((_, i) => i.toString());
        
        // 🟢 THE FIX: Mapping Open, High, Low, and Close for the Candlestick engine
        const data = recentCandles.map((c, i) => ({
            x: i.toString(),
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close
        }));

        const annotations = [];

        // 1. Current Price Line (Blue Dashed)
        if (currentPrice) {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: currentPrice,
                borderColor: 'rgba(56, 189, 248, 0.8)', borderWidth: 2, borderDash: [5, 5],
                label: { enabled: true, content: `PRICE: $${currentPrice}`, backgroundColor: 'rgba(56, 189, 248, 0.8)', fontSize: 10 }
            });
        }

        // 2. Macro POC Line (Amber)
        if (poc && poc !== "None") {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: parseFloat(poc),
                borderColor: 'rgba(245, 158, 11, 0.8)', borderWidth: 2,
                label: { enabled: true, content: 'MACRO POC', backgroundColor: 'rgba(245, 158, 11, 0.8)', fontSize: 10 }
            });
        }

        // 3. Upper Node (Slate)
        if (upperNode && upperNode !== "None") {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: parseFloat(upperNode),
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { enabled: true, content: 'UPPER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', fontSize: 10, position: 'left' }
            });
        }

        // 4. Lower Node (Slate)
        if (lowerNode && lowerNode !== "None") {
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: parseFloat(lowerNode),
                borderColor: 'rgba(148, 163, 184, 0.5)', borderWidth: 1,
                label: { enabled: true, content: 'LOWER NODE', backgroundColor: 'rgba(148, 163, 184, 0.8)', fontSize: 10, position: 'left' }
            });
        }

        // 5. Active Trap Line (Green/Red)
        if (trapPrice && trapSide) {
            const trapColor = trapSide === 'BUY' ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)';
            annotations.push({
                type: 'line', mode: 'horizontal', scaleID: 'y-axis-0', value: parseFloat(trapPrice),
                borderColor: trapColor, borderWidth: 2,
                label: { enabled: true, content: `TRAP: ${trapSide}`, backgroundColor: trapColor, fontSize: 10, position: 'right' }
            });
        }

        // Build the Chart.js JSON configuration
        const chartConfig = {
            type: 'candlestick', // 🟢 THE FIX: Converted from 'line' to 'candlestick'
            data: {
                labels: labels,
                datasets: [{
                    label: `${asset} (Last 50 Ticks)`,
                    data: data,
                    // 🟢 THE FIX: Hardcoding the wick and body colors to match your dark mode UI
                    color: {
                        up: 'rgba(16, 185, 129, 0.8)',   // Emerald
                        down: 'rgba(239, 68, 68, 0.8)',  // Red
                        unchanged: 'rgba(148, 163, 184, 0.8)' // Slate
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