// lib/discord-chart.js

export function buildRadarChartUrl({ asset, candles, poc, upperNode, lowerNode, currentPrice, trapPrice, trapSide }) {
    try {
        // Grab the last 50 closing prices
        const recentCandles = candles.slice(-50);
        const labels = recentCandles.map((_, i) => i.toString());
        const data = recentCandles.map(c => c.close);

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
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: `${asset} (Last 50 Ticks)`,
                    data: data,
                    borderColor: 'rgba(99, 102, 241, 1)', // Indigo 500
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    pointRadius: 0,
                    lineTension: 0.2
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

        // Encode it into a valid QuickChart URL
        const encodedChart = encodeURIComponent(JSON.stringify(chartConfig));
        return `https://quickchart.io/chart?c=${encodedChart}&w=600&h=300&bkg=020617&f=png`;

    } catch (e) {
        console.error("Failed to generate radar chart URL:", e);
        return null;
    }
}