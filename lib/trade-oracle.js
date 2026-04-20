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
        
        CRITICAL: Calculate a dynamic 'tp_price' (Take Profit) just before major overhead Macro resistance AND Order Book sell walls. Calculate a dynamic 'sl_price' (Stop Loss) just below major Macro structural support.
        
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
        
        CRITICAL DIRECTIVES FOR ACTIVE MANAGEMENT (ANTI-LIQUIDITY HUNT PROTOCOL):
        1. THE BREAKEVEN MANDATE: If the trade is currently in profit, you MUST NEVER let it turn into a loser. You are required to choose 'ADJUST_LIMITS' and move the 'sl_price' past the Entry Price ($${openTrade.entry_price}) to guarantee a risk-free trade, even if you want to keep the original Take Profit.
        2. THE SQUEEZE TRAP: Do not be fooled by "strong momentum" (like price being far below VWAP) when approaching a major target. Institutional algorithms intentionally accelerate momentum into support/resistance to create a fake-out before violently reversing the price to hunt Stop Losses. If the price is close to the Take Profit, FRONT-RUN THE SQUEEZE. Adjust the 'tp_price' closer to the current price to secure the win early.
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