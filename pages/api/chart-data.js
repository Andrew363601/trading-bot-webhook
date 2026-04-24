// pages/api/chart-data.js
export default async function handler(req, res) {
    const { asset, granularity } = req.query;
    
    if (!asset) return res.status(400).json({ error: "Asset is required" });

    // Format the asset for Coinbase Spot (e.g., BTC-USD)
    let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
    if (baseAsset === 'ETP') baseAsset = 'ETH';
    if (baseAsset === 'AVP') baseAsset = 'AVAX';
    if (baseAsset === 'BIP') baseAsset = 'BTC';
    if (baseAsset === 'SLP') baseAsset = 'SOL'; // 🟢 THE FIX: Map Solana Futures to Solana Spot
    
    const spotProduct = `${baseAsset}-USD`;
    const tfGranularity = granularity || 60;

    try {
        const response = await fetch(`https://api.exchange.coinbase.com/products/${spotProduct}/candles?granularity=${tfGranularity}`);
        
        if (!response.ok) throw new Error(`Coinbase API returned ${response.status}`);
        
        const data = await response.json();
        
        // Coinbase returns: [ time, low, high, open, close, volume ]
        const formattedData = data.map(d => ({
            time: d[0],
            low: d[1],
            high: d[2],
            open: d[3],
            close: d[4],
            volume: d[5] // 🟢 Included volume for the Heatmap
        })).sort((a, b) => a.time - b.time); 

        return res.status(200).json(formattedData);
    } catch (error) {
        console.error("[CHART PROXY ERROR]:", error.message);
        return res.status(500).json({ error: error.message });
    }
}