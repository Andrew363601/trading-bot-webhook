// tools/intent-oracle.js

// ---------------------------------------------------------
// 1. OPEN INTEREST FLOW (The Momentum Validator)
// ---------------------------------------------------------
export async function get_open_interest_flow({ symbol, macro_tf, trigger_tf }) {
    try {
        const cleanSymbol = symbol.split('-')[0]; // Converts ETP-20DEC30-CDE to ETP or ETH
        
        // Fetch current OI and historical OI from aggregator or exchange
        // Coinglass / Binance standard endpoint for OI derivatives
        const oiResp = await fetch(`https://open-api.coinglass.com/public/v2/open_interest?symbol=${cleanSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!oiResp.ok) throw new Error("Failed to fetch OI");
        const oiData = await oiResp.json();
        
        // Calculate the Delta (Are positions opening or closing?)
        const currentOI = oiData.data[0]?.openInterest || 0;
        const oneHourAgoOI = oiData.data[0]?.h1OpenInterest || currentOI; // Fallback to current if missing
        const oiDeltaPercent = ((currentOI - oneHourAgoOI) / oneHourAgoOI) * 100;

        let flowIntent = "NEUTRAL";
        if (oiDeltaPercent > 1.5) flowIntent = "NEW_MONEY_ENTERING (TREND CONFIRMED)";
        if (oiDeltaPercent < -1.5) flowIntent = "POSITIONS_CLOSING (SQUEEZE / EXHAUSTION)";

        return {
            symbol: cleanSymbol,
            current_open_interest: currentOI,
            one_hour_delta_percent: oiDeltaPercent.toFixed(2),
            flow_intent: flowIntent,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error("[OI ORACLE FAULT]", error.message);
        return { error: "Open Interest Flow Unavailable" };
    }
}

// ---------------------------------------------------------
// 2. FUNDING RATES (The Rubber Band Gauge)
// ---------------------------------------------------------
export async function get_funding_rates({ symbol }) {
    try {
        const cleanSymbol = symbol.split('-')[0]; 
        
        const fundingResp = await fetch(`https://open-api.coinglass.com/public/v2/funding?symbol=${cleanSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!fundingResp.ok) throw new Error("Failed to fetch Funding Rates");
        const fundingData = await fundingResp.json();

        // Average out the funding rate across major exchanges
        const rates = fundingData.data || [];
        const avgFunding = rates.reduce((acc, curr) => acc + (curr.fundingRate || 0), 0) / (rates.length || 1);
        const annualizedRate = avgFunding * 3 * 365 * 100; // 8-hour intervals

        let sentiment = "NEUTRAL";
        if (annualizedRate > 40) sentiment = "EXTREME_LONG_CROWDED (LOOK TO FADE / SHORT)";
        if (annualizedRate < -40) sentiment = "EXTREME_SHORT_CROWDED (ANTICIPATE LONG SQUEEZE)";

        return {
            symbol: cleanSymbol,
            current_8h_funding: avgFunding.toFixed(6),
            annualized_funding_percent: annualizedRate.toFixed(2),
            crowdedness_sentiment: sentiment
        };
    } catch (error) {
        console.error("[FUNDING ORACLE FAULT]", error.message);
        return { error: "Funding Rates Unavailable" };
    }
}

// ---------------------------------------------------------
// 3. LIQUIDATION MAP (The Magnet Tracker)
// ---------------------------------------------------------
export async function get_liquidation_map({ symbol }) {
    try {
        const cleanSymbol = symbol.split('-')[0];
        
        // Fetch liquidation heatmap data (Simulated structure for standard aggregator)
        // Aggregators provide clusters of high-leverage liquidations
        const liqResp = await fetch(`https://open-api.coinglass.com/public/v2/liquidation_map?symbol=${cleanSymbol}`, {
            headers: { 'coinglassSecret': process.env.COINGLASS_API_KEY }
        });
        
        if (!liqResp.ok) throw new Error("Failed to fetch Liquidation Map");
        const liqData = await liqResp.json();

        // Extract the largest clusters above and below current price
        const upperMagnet = liqData.data?.upper_cluster || { price: 0, leverage_volume: 0 };
        const lowerMagnet = liqData.data?.lower_cluster || { price: 0, leverage_volume: 0 };

        return {
            symbol: cleanSymbol,
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
        return { error: "Liquidation Map Unavailable" };
    }
}