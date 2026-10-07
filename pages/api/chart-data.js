// pages/api/chart-data.js
import { buildRadarChartUrl } from '../../lib/discord-chart.js';
import { normalizeProduct, SECONDS_TO_GRANULARITY } from '../../lib/candles.js';

export default async function handler(req, res) {
    const { asset, granularity, start, end, tp_price, sl_price, entry_price, trap_price, trap_side } = req.query;
    
    if (!asset) return res.status(400).json({ error: "Asset is required" });

    // 🟢 THE FIX: Universal Dynamic Dictionary for all Futures/Nano symbols
    const assetMap = {
        'ETP': 'ETH', 'BIT': 'BTC', 'BIP': 'BTC', 'SLP': 'SOL', 
        'AVP': 'AVAX', 'LCP': 'LTC', 'LNP': 'LINK', 'DOP': 'DOGE', 'BHP': 'BCH',
        'XPP': 'XRP', 'ADP': 'ADA', 'SUP': 'SOL' // Adding XPP and others
    };

    // 🟢 AM60 (ADD) — futures routing. BCP-20DEC30-CDE is a US-regulated BCH PERP
    // futures product (contract_size 1, price_increment 0.05) the legacy spot
    // endpoint cannot serve. Route any -CDE futures id whose base code is NOT in
    // the spot map above through the public CDP market-candles endpoint using the
    // EXACT product id. Mapped symbols (ETP/BIP/SLP/…) and all -PERP-INTX assets
    // keep the UNCHANGED legacy spot path — no regression for existing charts.
    const upperAsset = String(asset).toUpperCase().trim();
    const baseCode = upperAsset.split('-')[0];
    const isFuturesProduct = /-CDE$/.test(upperAsset) && !assetMap[baseCode];

    let baseAsset = asset.split('-')[0].replace('PERP', '').trim();
    baseAsset = assetMap[baseAsset] || baseAsset;
    
    const spotProduct = `${baseAsset}-USD`;
    const tfGranularity = parseInt(granularity) || 60;
    const requestedLimit = parseInt(req.query.limit) || 300;

    try {
        let allData = [];
        let currentEnd = end ? parseInt(end) : Math.floor(Date.now() / 1000);
        let remaining = Math.min(requestedLimit, 1500); // Hard cap for safety

        if (isFuturesProduct) {
            // --- CDP public market candles (unmapped -CDE futures, e.g. BCP-20DEC30-CDE) ---
            const product = normalizeProduct(upperAsset); // hyphenated id passes through intact
            const enumGran = SECONDS_TO_GRANULARITY[tfGranularity] || 'ONE_HOUR';
            let cursorEnd = end ? parseInt(end) : Math.floor(Date.now() / 1000);
            while (remaining > 0) {
                const batchSize = Math.min(remaining, 300);
                const cursorStart = start ? Math.max(parseInt(start), cursorEnd - (batchSize * tfGranularity)) : cursorEnd - (batchSize * tfGranularity);
                const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(product)}/candles?start=${cursorStart}&end=${cursorEnd}&granularity=${enumGran}`;
                const response = await fetch(url);
                if (!response.ok) break;
                const json = await response.json();
                const batch = Array.isArray(json?.candles) ? json.candles : [];
                if (batch.length === 0) break;
                const times = [];
                for (const c of batch) {
                    const epochSec = (typeof c.start === 'number' || /^\d+$/.test(String(c.start)))
                        ? Math.floor(Number(c.start))
                        : Math.floor(new Date(c.start).getTime() / 1000);
                    if (!Number.isFinite(epochSec) || epochSec <= 0) continue;
                    const o = parseFloat(c.open), h = parseFloat(c.high), l = parseFloat(c.low), cl = parseFloat(c.close);
                    if (![o, h, l, cl].every(Number.isFinite)) continue;
                    // Push the SAME tuple shape as the legacy spot API so the shared
                    // formattedData mapping below works unchanged for both branches.
                    allData.push([epochSec, l, h, o, cl, parseFloat(c.volume) || 0]);
                    times.push(epochSec);
                }
                if (times.length === 0) break;
                const oldestInBatch = Math.min(...times);
                if (!Number.isFinite(oldestInBatch) || oldestInBatch >= cursorEnd) break; // no-progress guard
                cursorEnd = oldestInBatch;
                remaining -= batch.length;
                if (start && cursorEnd <= parseInt(start)) break;
                if (batch.length < batchSize) break; // End of available data
            }
        } else
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

        // AM60 — an empty payload must never be reusable by a downstream/edge cache.
        // (No ETag/304 exists here; this is the cheap guard so a stale empty body
        // can't be pinned for a symbol that later gains data.)
        if (deduplicated.length === 0) res.setHeader('Cache-Control', 'no-store');

        // If TP/SL params provided, return chart URL alongside candles
        if (tp_price || sl_price || entry_price) {
            const currentPrice = deduplicated.length > 0 ? deduplicated[deduplicated.length - 1].close : null;
            const chartUrl = await buildRadarChartUrl({
                asset,
                candles: deduplicated.slice(-50),
                currentPrice,
                tpPrice: tp_price || null,
                slPrice: sl_price || null,
                trapPrice: trap_price || null,
                trapSide: trap_side || null,
                openTrade: entry_price ? { entry_price } : null
            });
            return res.status(200).json({ candles: deduplicated, chartUrl });
        }

        return res.status(200).json(deduplicated);
    } catch (error) {
        console.error("[CHART PROXY ERROR]:", error);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(500).json({ error: "Failed to fetch chart data", details: error.message });
    }
}