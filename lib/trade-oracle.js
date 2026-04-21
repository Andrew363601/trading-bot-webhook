// lib/trade-oracle.js

export async function evaluateTradeIdea({ mode, asset, strategy, signal, currentPrice, candles, macroCandles = [], indicators = {}, derivativesData = {}, orderBook = {}, pnlPercent = 0, marketType = 'FUTURES', openTrade = null }) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const recentTriggerCandles = candles.slice(-150);
    const recentMacroCandles = macroCandles.slice(-50);
    
    let prompt = "";
    let expectedOutput = "";

    const sizingContext = marketType === 'SPOT' 
        ? "Since this is a SPOT market, leverage is not applicable. If conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' (e.g., 1.5 for 50% more USD allocation). Otherwise, return 1.0."
        : "Since this is a FUTURES market, if conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' to increase the leveraged position size (e.g., 1.5 for 50% more size). Otherwise, return 1.0.";

    const mtfaContext = `
    MULTI-TIMEFRAME ANALYSIS (MTFA) REQUIRED:
    1. MACRO Candles (Higher Timeframe): Use to determine overarching market regime and major historical liquidity zones.
    2. TRIGGER Candles (Local Timeframe): Use to evaluate immediate momentum.
    `;

    const microstructureContext = `
    MARKET MICROSTRUCTURE & X-RAY VISION:
    - Technical Indicators: ${JSON.stringify(indicators)} (Use VWAP and ATR to pinpoint exact limit order entries on micro-pullbacks).
    - Level 2 Order Book Imbalance: ${JSON.stringify(orderBook)} (CRITICAL: You MUST use heavy bid/ask liquidity walls to strategically place Take Profits just IN FRONT of sell walls, and Stop Losses just BEHIND buy walls).
    - Derivatives Engine: ${JSON.stringify(derivativesData)}
    `;

    if (mode === 'ENTRY') {
        prompt = `
        A ${signal} signal just flashed for ${asset} at a current market price of $${currentPrice} using the ${strategy} strategy.
        
        ${mtfaContext}
        ${microstructureContext}
        
        Determine if this is a high-probability continuation/breakout, or a false micro-signal slamming into a Macro support/resistance wall or an Order Book liquidity trap.
        
        THE ENTRY PROTOCOL:
        1. If momentum is standard, calculate the optimal 'limit_price' entry on a micro-pullback (e.g., to the VWAP) for a better risk/reward.
        2. If momentum is EXPLOSIVE and the trend is running away, DO NOT wait for a deep pullback. Calculate a 'limit_price' AT OR SLIGHTLY BEYOND the current market price ($${currentPrice}) to guarantee the order fills immediately. Do not miss the trade trying to save a few pennies.
        
        CRITICAL: Calculate a dynamic 'sl_price' (Stop Loss) safely below major Macro structural support. You MUST factor in extreme local volatility and add a wide ATR buffer to your Stop Loss to prevent premature liquidation from market wicks
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'REVERSAL' && openTrade) {
        prompt = `
        CONTEXT AWARENESS REQUIRED: We are currently holding an open ${openTrade.side} position on ${asset} from an entry of $${openTrade.entry_price}. 
        The current floating PnL is ${openTrade.pnl_percent}%. Current market price is $${currentPrice}.
        
        A CONTRARY ${signal} signal just flashed.
        
        ${mtfaContext}
        ${microstructureContext}
        
        CRITICAL WARNING: You must VETO this new signal UNLESS the MACRO timeframe or Order Book shows a massive, undeniable structural trend reversal that guarantees our current ${openTrade.side} position is doomed.
        If it is just temporary chop, VETO the signal to hold our original ${openTrade.side} position and let the mathematical Stop Loss handle risk.
        
        If you APPROVE the reversal, calculate the optimal limit order entry price to execute the flip, and provide new Macro S/R targets for 'tp_price' and 'sl_price'.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'EMERGENCY') {
        prompt = `
        URGENT: An open ${strategy} trade on ${asset} is currently down ${(pnlPercent * 100).toFixed(2)}%. Current price is $${currentPrice}.
        
        ${mtfaContext}
        ${microstructureContext}
        
        Has the core Macro market regime structurally failed? Are massive order book walls building against us?
        Should we HOLD and wait for the physical exchange Stop Loss, or execute an emergency MARKET_CLOSE to prevent further destruction?
        `;
        expectedOutput = `{\n  "action": "HOLD" | "MARKET_CLOSE",\n  "conviction_score": 0-100,\n  "reasoning": "string"\n}`;

    } else if (mode === 'MANUAL_REVIEW' && openTrade) {
        prompt = `
        MANUAL SNIPER / TRIPWIRE REVIEW INITIATED: A tactical re-evaluation of this open ${openTrade.side} position on ${asset} is required.
        Entry Price: $${openTrade.entry_price}. Current Price: $${currentPrice}. Floating PnL: ${(pnlPercent * 100).toFixed(2)}%.
        Current Active Targets - Take Profit: $${openTrade.tp_price || 'None'}, Stop Loss: $${openTrade.sl_price || 'None'}.
        
        ${mtfaContext}
        ${microstructureContext}
        
        CRITICAL DIRECTIVES FOR ACTIVE MANAGEMENT (THE HYBRID TRIPWIRE PROTOCOL):
        You MUST evaluate the current momentum to decide how aggressively to protect this profit. You must choose 'ADJUST_LIMITS' and do one of the following:
        
        1. THE BREAKEVEN STOP (If strong continuation is highly probable): If the micro-trend is incredibly strong, volume is accelerating, and you have high conviction it will hit the original Take Profit, move the 'sl_price' JUST PAST the Entry Price ($${openTrade.entry_price}) to guarantee a risk-free trade, but leave the 'tp_price' alone (or trail it slightly) to let the runner breathe.
        
        2. THE AGGRESSIVE TRAIL / SQUEEZE TRAP (If momentum is fading or hitting a wall): If volume is dying, resistance is building, or you suspect institutional fake-out (liquidity hunt), aggressively hike the 'sl_price' deep into profit territory to lock in 50%-75% of the current gains. If a squeeze is imminent, FRONT-RUN THE TARGET by bringing the 'tp_price' much closer to the current price to secure the win immediately.
        
        3. If the macro structure has completely failed against us, choose MARKET_CLOSE.
        
        CRITICAL: Do NOT choose 'HOLD' if the trade is in profit but the Stop Loss is still in negative territory. You must use 'ADJUST_LIMITS' to secure the downside.
        `;
        expectedOutput = `{\n  "action": "HOLD" | "MARKET_CLOSE" | "ADJUST_LIMITS",\n  "conviction_score": 0-100,\n  "tp_price": [New Take Profit Number or null],\n  "sl_price": [New Stop Loss Number or null],\n  "reasoning": "string"\n}`;
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
                const fallbackAction = mode === 'MANUAL_REVIEW' ? 'HOLD' : (mode === 'ENTRY' || mode === 'REVERSAL' ? 'VETO' : 'HOLD');
                return { action: fallbackAction, reasoning: 'Oracle timeout due to API congestion.' };
            }
        }
    }
}