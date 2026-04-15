// lib/trade-oracle.js

export async function evaluateTradeIdea({ mode, asset, strategy, signal, currentPrice, candles, pnlPercent = 0, marketType = 'FUTURES', openTrade = null }) {
    // 1. You can change 'gemini-2.5-flash' to 'gemini-3-flash' or 'gemini-2.5-pro' here if congestion continues
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const recentCandles = candles.slice(-150);
    
    let prompt = "";
    let expectedOutput = "";

    const sizingContext = marketType === 'SPOT' 
        ? "Since this is a SPOT market, leverage is not applicable. If conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' (e.g., 1.5 for 50% more USD allocation). Otherwise, return 1.0."
        : "Since this is a FUTURES market, if conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' to increase the leveraged position size (e.g., 1.5 for 50% more size). Otherwise, return 1.0.";

    if (mode === 'ENTRY') {
        prompt = `
        A ${signal} signal just flashed for ${asset} at a current market price of $${currentPrice} using the ${strategy} strategy.
        Analyze the recent 150 candles. Determine if this is a high-probability continuation/breakout, or a false signal into support/resistance.
        
        If this is a solid setup, DO NOT buy at market price. Calculate the optimal limit order entry price on a micro-pullback (e.g., VWAP, EMA, or recent support).
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'REVERSAL' && openTrade) {
        prompt = `
        CONTEXT AWARENESS REQUIRED: We are currently holding an open ${openTrade.side} position on ${asset} from an entry of $${openTrade.entry_price}. 
        The current floating PnL is ${openTrade.pnl_percent}%. Current market price is $${currentPrice}.
        
        A CONTRARY ${signal} signal just flashed using the ${strategy} strategy.
        
        Analyze the recent 150 candles. 
        Is this new ${signal} signal a structural trend reversal that warrants taking the PnL hit to close our ${openTrade.side} and flip directions? 
        Or is this just a temporary micro-pullback (chop) and we should VETO the new signal to hold our original ${openTrade.side} position?
        
        If you APPROVE the reversal, calculate the optimal limit order entry price to execute the flip.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'EMERGENCY') {
        prompt = `
        URGENT: An open ${strategy} trade on ${asset} is currently down ${(pnlPercent * 100).toFixed(2)}%. Current price is $${currentPrice}.
        Analyze the 150 candles. Has the core market regime structurally failed (e.g., a mean reversion trade caught in a massive new trend)?
        Should we HOLD and wait for the mathematical Stop Loss, or execute an emergency MARKET_CLOSE to prevent further destruction?
        `;
        expectedOutput = `{\n  "action": "HOLD" | "MARKET_CLOSE",\n  "conviction_score": 0-100,\n  "reasoning": "string"\n}`;
    }

    const payload = {
      systemInstruction: { parts: [{ text: "You are an elite quantitative execution risk manager. Output ONLY raw, valid JSON." }] },
      contents: [{
        role: "user",
        parts: [{ text: prompt + `\n\nRecent Candles: ${JSON.stringify(recentCandles)}\n\nREQUIRED JSON OUTPUT:\n${expectedOutput}` }]
      }],
      generationConfig: { responseMimeType: "application/json" }
    };

    // --- EXPONENTIAL BACKOFF RETRY LOGIC ---
    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        try {
            const resp = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            
            if (!resp.ok) {
                const errorText = await resp.text();
                // If it's a 503 High Demand error, we intercept it and trigger a retry instead of failing
                if (resp.status === 503 || resp.status === 429) {
                    attempts++;
                    console.warn(`[ORACLE WARN] Google API Congestion (Status ${resp.status}). Retrying... Attempt ${attempts}/${maxRetries}`);
                    if (attempts >= maxRetries) throw new Error(`Max retries reached. Last error: ${errorText}`);
                    
                    // Wait 1.5s, then 3s, then 4.5s
                    await new Promise(resolve => setTimeout(resolve, 1500 * attempts));
                    continue; // Loop back and try again
                }
                throw new Error(`Gemini rejected: ${resp.status} - ${errorText}`);
            }

            const data = await resp.json();
            const cleanJsonString = data.candidates[0].content.parts[0].text;
            return JSON.parse(cleanJsonString);

        } catch (err) {
            if (attempts >= maxRetries) {
                console.error(`[ORACLE FATAL] ${asset}:`, err.message);
                return (mode === 'ENTRY' || mode === 'REVERSAL') ? { action: 'VETO', reasoning: 'Oracle timeout due to severe API congestion.' } : { action: 'HOLD', reasoning: 'Oracle timeout.' };
            }
        }
    }
}