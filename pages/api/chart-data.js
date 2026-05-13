// pages/api/chart-data.js
export default async function handler(req, res) {
    const { asset, granularity, start, end } = req.query;
    
    if (!asset) return res.status(400).json({ error: "Asset is required" });

    // 🟢 THE FIX: Universal Dynamic Dictionary for all Futures/Nano symbols
    const assetMap = {
        'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 
        'AVP': 'AVAX', 'LCP': 'LTC', 'LNP': 'LINK', 'DOP': 'DOGE', 'BHP': 'BCH',
        'XPP': 'XRP', 'ADP': 'ADA', 'SUP': 'SOL' // Adding XPP and others
    };

    let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
    baseAsset = assetMap[baseAsset] || baseAsset;
    
    const spotProduct = `${baseAsset}-USD`;
    const tfGranularity = parseInt(granularity) || 60;
    const requestedLimit = parseInt(req.query.limit) || 300;

    try {
        let allData = [];
        let currentEnd = end ? parseInt(end) : Math.floor(Date.now() / 1000);
        let remaining = Math.min(requestedLimit, 1500); // Hard cap for safety

        while (remaining > 0) {
            const batchSize = Math.min(remaining, 300);
            const currentStart = start ? Math.max(parseInt(start), currentEnd - (batchSize * tfGranularity)) : currentEnd - (batchSize * tfGranularity);
            
            const url = `https://api.exchange.coinbase.com/products/${spotProduct}/candles?granularity=${tfGranularity}&start=${currentStart}&end=${currentEnd}`;
            const response = await fetch(url);
            
            if (!response.ok) break;
            
            const batchData = await response.json();
            if (!Array.isArray(batchData) || batchData.length === 0) break;

            allData = allData.concat(batchData);
            
            // Move end time back for next batch
            const oldestInBatch = Math.min(...batchData.map(d => d[0]));
            currentEnd = oldestInBatch;
            remaining -= batchData.length;

            if (start && currentEnd <= parseInt(start)) break;
            if (batchData.length < batchSize) break; // End of available data
        }
        
        const formattedData = allData.map(d => ({
            time: d[0],
            low: d[1],
            high: d[2],
            open: d[3],
            close: d[4],
            volume: d[5] 
        })).sort((a, b) => a.time - b.time); 

        // Deduplicate by time (sometimes batches overlap)
        const seen = new Set();
        const deduplicated = formattedData.filter(d => {
            if (seen.has(d.time)) return false;
            seen.add(d.time);
            return true;
        });

        return res.status(200).json(deduplicated);
    } catch (error) {
        console.error("[CHART PROXY ERROR]:", error);
        return res.status(500).json({ error: "Failed to fetch chart data", details: error.message });
    }
}