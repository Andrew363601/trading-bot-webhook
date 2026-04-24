// pages/api/chart-data.js
export default async function handler(req, res) {
    const { asset, granularity } = req.query;
    
    if (!asset) return res.status(400).json({ error: "Asset is required" });

    // 🟢 THE FIX: Universal Dynamic Dictionary for all Futures/Nano symbols
    const assetMap = {
        'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 
        'AVP': 'AVAX', 'LCP': 'LTC', 'LNP': 'LINK', 'DOP': 'DOGE', 'BHP': 'BCH'
    };

    let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
    baseAsset = assetMap[baseAsset] || baseAsset;
    
    const spotProduct = `${baseAsset}-USD`;
    const tfGranularity = granularity || 60;

    try {
        const response = await fetch(`https://api.exchange.coinbase.com/products/${spotProduct}/candles?granularity=${tfGranularity}`);
        
        if (!response.ok) throw new Error(`Coinbase API returned ${response.status}`);
        
        const data = await response.json();
        
        const formattedData = data.map(d => ({
            time: d[0],
            low: d[1],
            high: d[2],
            open: d[3],
            close: d[4],
            volume: d[5] 
        })).sort((a, b) => a.time - b.time); 

        return res.status(200).json(formattedData);
    } catch (error) {
        console.error("[CHART PROXY ERROR]:", error.message);
        return res.status(500).json({ error: error.message });
    }
}