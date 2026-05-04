// tools/intent-oracle.js

// 🟢 THE FIX 1: Delay helper to stagger concurrent requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Translate Coinbase Testnet tickers into Global Market Tickers
function getStandardSymbol(coinbaseSymbol) {
    if (coinbaseSymbol.includes('BIP') || coinbaseSymbol.includes('BTC')) return 'BTC';
    if (coinbaseSymbol.includes('ETP') || coinbaseSymbol.includes('ETH')) return 'ETH';
    if (coinbaseSymbol.includes('SLP') || coinbaseSymbol.includes('SOL')) return 'SOL';
    if (coinbaseSymbol.includes('DOP') || coinbaseSymbol.includes('DOGE')) return 'DOGE';
    if (coinbaseSymbol.includes('LCP') || coinbaseSymbol.includes('LTC')) return 'LTC';
    if (coinbaseSymbol.includes('LNP') || coinbaseSymbol.includes('LINK')) return 'LINK';
    if (coinbaseSymbol.includes('AVP') || coinbaseSymbol.includes('AVAX')) return 'AVAX';
    return coinbaseSymbol.split('-')[0]; // Fallback
}

// ---------------------------------------------------------
// 1. OPEN INTEREST FLOW (The Momentum Validator)
// ---------------------------------------------------------
export async function get_open_interest_flow({ symbol, macro_tf, trigger_tf }) {
    const realSymbol = getStandardSymbol(symbol);
    const apiSymbol = `${realSymbol}USDT`; // 🟢 THE FIX 2: Append USDT for Coinglass

    try {
        // Fires immediately (0ms delay)
        const oiResp = await fetch(`https://open-api.coinglass.com/public/v2/open_interest?symbol=${apiSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!oiResp.ok) throw new Error(`API Rejected: ${oiResp.status}`);
        const oiData = await oiResp.json();
        if (!oiData || !oiData.data || !oiData.data[0]) throw new Error("Invalid API Data Structure");
        
        const currentOI = oiData.data[0]?.openInterest || 0;
        const oneHourAgoOI = oiData.data[0]?.h1OpenInterest || currentOI; 
        const oiDeltaPercent = oneHourAgoOI > 0 ? ((currentOI - oneHourAgoOI) / oneHourAgoOI) * 100 : 0;

        let flowIntent = "NEUTRAL";
        if (oiDeltaPercent > 1.5) flowIntent = "NEW_MONEY_ENTERING (TREND CONFIRMED)";
        if (oiDeltaPercent < -1.5) flowIntent = "POSITIONS_CLOSING (SQUEEZE / EXHAUSTION)";

        return {
            symbol: realSymbol,
            current_open_interest: currentOI,
            one_hour_delta_percent: oiDeltaPercent.toFixed(2),
            flow_intent: flowIntent,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error("[OI ORACLE FAULT]", error.message);
        // 🟢 THE FIX 3: Shock Absorbers (Safe Neutral Fallback)
        return {
            symbol: realSymbol,
            current_open_interest: 0,
            one_hour_delta_percent: "0.00",
            flow_intent: "UNKNOWN (API RATE LIMITED)",
            timestamp: new Date().toISOString()
        };
    }
}

// ---------------------------------------------------------
// 2. FUNDING RATES (The Rubber Band Gauge)
// ---------------------------------------------------------
export async function get_funding_rates({ symbol }) {
    const realSymbol = getStandardSymbol(symbol);
    const apiSymbol = `${realSymbol}USDT`; 

    try {
        await delay(1000); // 🟢 THE FIX 1: Space out by 1 second
        
        const fundingResp = await fetch(`https://open-api.coinglass.com/public/v2/funding?symbol=${apiSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!fundingResp.ok) throw new Error(`API Rejected: ${fundingResp.status}`);
        const fundingData = await fundingResp.json();
        if (!fundingData || !fundingData.data) throw new Error("Invalid API Data Structure");

        const rates = fundingData.data || [];
        const avgFunding = rates.reduce((acc, curr) => acc + (curr.fundingRate || 0), 0) / (rates.length || 1);
        const annualizedRate = avgFunding * 3 * 365 * 100; 

        let sentiment = "NEUTRAL";
        if (annualizedRate > 40) sentiment = "EXTREME_LONG_CROWDED (LOOK TO FADE / SHORT)";
        if (annualizedRate < -40) sentiment = "EXTREME_SHORT_CROWDED (ANTICIPATE LONG SQUEEZE)";

        return {
            symbol: realSymbol,
            current_8h_funding: avgFunding.toFixed(6),
            annualized_funding_percent: annualizedRate.toFixed(2),
            crowdedness_sentiment: sentiment
        };
    } catch (error) {
        console.error("[FUNDING ORACLE FAULT]", error.message);
        return {
            symbol: realSymbol,
            current_8h_funding: "0.000000",
            annualized_funding_percent: "0.00",
            crowdedness_sentiment: "UNKNOWN (API RATE LIMITED)"
        };
    }
}

// ---------------------------------------------------------
// 3. LIQUIDATION MAP (The Magnet Tracker)
// ---------------------------------------------------------
export async function get_liquidation_map({ symbol }) {
    const realSymbol = getStandardSymbol(symbol);
    const apiSymbol = `${realSymbol}USDT`; 

    try {
        await delay(2000); // 🟢 THE FIX 1: Space out by 2 seconds
        
        const liqResp = await fetch(`https://open-api.coinglass.com/public/v2/liquidation_map?symbol=${apiSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!liqResp.ok) throw new Error(`API Rejected: ${liqResp.status}`);
        const liqData = await liqResp.json();
        if (!liqData || !liqData.data) throw new Error("Invalid API Data Structure");

        const upperMagnet = liqData.data?.upper_cluster || { price: 0, leverage_volume: 0 };
        const lowerMagnet = liqData.data?.lower_cluster || { price: 0, leverage_volume: 0 };

        return {
            symbol: realSymbol,
            upper_liquidation_magnet: {
                target_price: upperMagnet.price,
                estimated_liquidation_volume: upperMagnet.leverage_volume,
                action: "Target for Long Take-Profit / Short Squeeze"
            },
            lower_liquidation_magnet: {
                target_price: lowerMagnet.price,
                estimated_liquidation_volume: lowerMagnet.leverage_volume,
                action: "Target for Short Take-Profit / Long Flush"
            }
        };
    } catch (error) {
        console.error("[LIQ MAP ORACLE FAULT]", error.message);
        return {
            symbol: realSymbol,
            upper_liquidation_magnet: { target_price: 0, estimated_liquidation_volume: 0, action: "UNKNOWN (API RATE LIMITED)" },
            lower_liquidation_magnet: { target_price: 0, estimated_liquidation_volume: 0, action: "UNKNOWN (API RATE LIMITED)" }
        };
    }
}