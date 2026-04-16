// lib/trade-oracle.js

export async function evaluateTradeIdea({ mode, asset, strategy, signal, currentPrice, candles, macroCandles = [], pnlPercent = 0, marketType = 'FUTURES', openTrade = null }) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    // We pass the last 150 trigger candles (micro) and the last 50 macro candles (bigger picture S/R)
    const recentTriggerCandles = candles.slice(-150);
    const recentMacroCandles = macroCandles.slice(-50);
    
    let prompt = "";
    let expectedOutput = "";

    const sizingContext = marketType === 'SPOT' 
        ? "Since this is a SPOT market, leverage is not applicable. If conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' (e.g., 1.5 for 50% more USD allocation). Otherwise, return 1.0."
        : "Since this is a FUTURES market, if conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' to increase the leveraged position size (e.g., 1.5 for 50% more size). Otherwise, return 1.0.";

    const mtfaContext = `
    MULTI-TIMEFRAME ANALYSIS (MTFA) REQUIRED:
    You are provided with two data sets:
    1. MACRO Candles (Higher Timeframe): Use this to determine the overarching market regime and identify major historical liquidity, support, and resistance zones.
    2. TRIGGER Candles (Local Timeframe): Use this to evaluate the immediate momentum of the signal and pinpoint the exact micro-entry.
    `;

    if (mode === 'ENTRY') {
        prompt = `
        A ${signal} signal just flashed for ${asset} at a current market price of $${currentPrice} using the ${strategy} strategy.
        
        ${mtfaContext}
        
        Determine if this is a high-probability continuation/breakout, or a false micro-signal that is slamming into a Macro support/resistance wall.
        
        If this is a solid setup, DO NOT buy at market price. Calculate the optimal 'limit_price' entry on a micro-pullback (e.g., VWAP, EMA) using the Trigger Candles.
        CRITICAL: You must calculate a dynamic 'tp_price' (Take Profit) just before major Macro overhead resistance, and a dynamic 'sl_price' (Stop Loss) just below major Macro structural support. Do not settle for tiny scalps if the Macro chart allows for a massive swing trade.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'REVERSAL' && openTrade) {
        prompt = `
        CONTEXT AWARENESS REQUIRED: We are currently holding an open ${openTrade.side} position on ${asset} from an entry of $${openTrade.entry_price}. 
        The current floating PnL is ${openTrade.pnl_percent}%. Current market price is $${currentPrice}.
        
        A CONTRARY ${signal} signal just flashed using the ${strategy} strategy.
        
        CRITICAL WARNING - AVOID WHIPSAWING: Algorithmic strategies often spam continuous reversal signals during temporary micro-chop. 
        ${mtfaContext}
        
        You must VETO this new signal UNLESS the MACRO timeframe shows a massive, undeniable structural trend reversal that guarantees our current ${openTrade.side} position is doomed.
        If it is just temporary chop or a micro-pullback on the Trigger timeframe, VETO the signal to hold our original ${openTrade.side} position and let the mathematical Stop Loss handle risk.
        
        If you APPROVE the reversal, calculate the optimal limit order entry price to execute the flip, and provide new Macro S/R targets for 'tp_price' and 'sl_price'.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'EMERGENCY') {
        prompt = `
        URGENT: An open ${strategy} trade on ${asset} is currently down ${(pnlPercent * 100).toFixed(2)}%. Current price is $${currentPrice}.
        
        ${mtfaContext}
        
        Has the core Macro market regime structurally failed (e.g., a mean reversion trade caught in a massive new trend)?
        Should we HOLD and wait for the physical exchange Stop Loss, or execute an emergency MARKET_CLOSE to prevent further destruction?
        `;
        expectedOutput = `{\n  "action": "HOLD" | "MARKET_CLOSE",\n  "conviction_score": 0-100,\n  "reasoning": "string"\n}`;
    }

    const payload = {
      systemInstruction: { parts: [{ text: "You are an elite quantitative execution risk manager. Output ONLY raw, valid JSON." }] },
      contents: [{
        role: "user",
        parts: [{ text: prompt + `\n\nMacro Candles: ${JSON.stringify(recentMacroCandles)}\nTrigger Candles: ${JSON.stringify(recentTriggerCandles)}\n\nREQUIRED JSON OUTPUT:\n${expectedOutput}` }]
      }],
      generationConfig: { responseMimeType: "application/json" }
    };

    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        try {
            const resp = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            
            if (!resp.ok) {
                const errorText = await resp.text();
                if (resp.status === 503 || resp.status === 429) {
                    attempts++;
                    console.warn(`[ORACLE WARN] Google API Congestion (Status ${resp.status}). Retrying... Attempt ${attempts}/${maxRetries}`);
                    if (attempts >= maxRetries) throw new Error(`Max retries reached. Last error: ${errorText}`);
                    
                    await new Promise(resolve => setTimeout(resolve, 1500 * attempts));
                    continue; 
                }
                throw new Error(`Gemini rejected: ${resp.status} - ${errorText}`);
            }

            const data = await resp.json();
            let cleanJsonString = data.candidates[0].content.parts[0].text;
            
            cleanJsonString = cleanJsonString.replace(/```json/g, '').replace(/```/g, '').trim();
            
            return JSON.parse(cleanJsonString);

        } catch (err) {
            if (attempts >= maxRetries) {
                console.error(`[ORACLE FATAL] ${asset}:`, err.message);
                return (mode === 'ENTRY' || mode === 'REVERSAL') ? { action: 'VETO', reasoning: 'Oracle timeout due to severe API congestion.' } : { action: 'HOLD', reasoning: 'Oracle timeout.' };
            }
        }
    }
}