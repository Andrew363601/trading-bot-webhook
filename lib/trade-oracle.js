// lib/trade-oracle.js

export async function evaluateTradeIdea({ mode, asset, strategy, signal, currentPrice, candles, macroCandles = [], indicators = {}, derivativesData = {}, orderBook = {}, pnlPercent = 0, marketType = 'FUTURES', openTrade = null, recentHistory = [], dynamicSizing = false }) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const recentTriggerCandles = candles.slice(-150);
    const recentMacroCandles = macroCandles.slice(-50);
    
    let prompt = "";
    let expectedOutput = "";

    // 🧠 DYNAMIC SIZING UI TOGGLE
    let sizingContext = "";
    if (dynamicSizing) {
        sizingContext = `
        DYNAMIC POSITION SIZING IS [ENABLED]: 
        Analyze your 24-hour win rate in the Short-Term Memory. 
        - If you are on a hot streak (high win rate), you MAY output a 'size_multiplier' between 1.1 and 2.0 to aggressively compound profits by scaling up contract size.
        - If you are on a cold streak (taking losses), you MUST output a 'size_multiplier' between 0.5 and 0.8 to actively defend capital and bleed slowly.
        - For GOD-TIER setups (Conviction >= 90) with undeniable macro breakout alignment and volume, you are authorized to output a 5.0 to 10.0 'size_multiplier' for maximum ROI. If you deploy a 5x-10x multiplier, your 'reasoning' MUST explicitly state why the macro structure justifies this massive sizing.
        - Otherwise, output 1.0.
        `;
    } else {
        sizingContext = `DYNAMIC POSITION SIZING IS [DISABLED]. You MUST output a 'size_multiplier' of 1.0. Do not alter position size.`;
    }

    const mtfaContext = `
    MULTI-TIMEFRAME ANALYSIS (MTFA) REQUIRED:
    1. MACRO Candles (Higher Timeframe): Use to determine overarching market regime and major historical liquidity zones.
    2. TRIGGER Candles (Local Timeframe): Use to evaluate immediate momentum.
    `;

    // 🧠 NEW: X-RAY VISION (CVD, HEATMAPS, PREMIUMS)
    const microstructureContext = `
    MARKET MICROSTRUCTURE & X-RAY VISION (CRITICAL FOR TRAP DETECTION):
    - Technical Indicators: ${JSON.stringify(indicators)}
      * CRITICAL CVD CHECK: If CVD (Cumulative Volume Delta) is dropping heavily while price is rising, this is a BEARISH DIVERGENCE (Institutions are quietly selling into retail liquidity). You MUST VETO LONGS and look for a Short.
      * Use VWAP and ATR to pinpoint exact limit order entries on micro-pullbacks.
    - Level 2 Order Book Imbalance: ${JSON.stringify(orderBook)} 
      * CRITICAL WALL CHECK: Compare bid size to ask size. If you see a massive ask wall and empty bids (a Liquidity Void below), the floor will fall out. VETO longs.
      * Place Take Profits just IN FRONT of massive sell walls, and Stop Losses safely BEHIND massive buy walls.
    - Derivatives Engine (Spot-Futures Basis): ${JSON.stringify(derivativesData)}
      * CRITICAL FUNDING CHECK: If the Futures price is trading at a massive premium to the Spot price (Overheated Longs), the market is top-heavy and primed for a liquidation cascade downward. Do NOT buy the top of a premium.
    `;

    // 🧠 THE MEMORY MODULE & OBJECTIVE FUNCTION
    const memoryContext = `
    SHORT-TERM MEMORY (YOUR RECENT TRADES FOR ${asset}):
    ${recentHistory.length > 0 ? recentHistory.map(t => `- ${t.side} | PnL: $${t.pnl} | Reason: ${t.reason?.split('\n').pop() || 'Unknown'}`).join('\n') : "No recent trades available for context."}
    
    YOUR MISSION (THE OBJECTIVE FUNCTION):
    1. Maximize Absolute ROI (Adaptive Brackets): If your recent trades show you are perfectly synchronized with the market (winning trades hitting Take Profit), you should aggressively stretch your 'tp_price' targets further away to capture maximum value. Do not leave money on the table.
    2. Defend Against Wicks: If your recent trades show you are repeatedly getting stopped out before the price runs in your favor, you MUST intentionally widen your ATR buffer on the 'sl_price' to survive liquidity sweeps.
    3. Regime Prioritization: Use the failures or successes of your recent trades to confidently diagnose the current market regime. 
    4. The Shadow Portfolio (VETO Context): You will see 'SHADOW VETO' entries in your memory. These are trades you intentionally rejected to avoid traps. If you recently vetoed multiple Longs anticipating a crash, and a SHORT signal now fires, use this shadow context to drastically increase your Conviction. Trust your prior analysis.

    CRITICAL MANDATE (ANTI-PTSD PROTOCOL): Use this memory to avoid whipsawing in chop, BUT DO NOT let recency bias paralyze you. If you have recent losses, be cautious of weak signals. HOWEVER, if the current technicals (Volume, MACRO trend, and structural breakout) are undeniably strong, you MUST OVERRIDE your fear of recent losses and APPROVE the trade.
    
    *THE ELITE OVERRIDE RULE:* If you invoke this override to take a trade immediately after a recent loss, the new setup MUST command an elite Conviction Score of 85 or higher. If you can only grade the setup a 75 or 80, it is NOT 'undeniably strong', and you MUST VETO it.
    `;

    if (mode === 'ENTRY') {
        prompt = `
        A ${signal} signal just flashed for ${asset} at a current market price of $${currentPrice} using the ${strategy} strategy.
        
        ${mtfaContext}
        ${microstructureContext}
        ${memoryContext}
        
        Determine if this is a high-probability continuation/breakout, or a false micro-signal slamming into a Macro support/resistance wall or an Order Book liquidity trap. Utilize the Shadow Portfolio context to confirm directional bias.
        
        THE ENTRY PROTOCOL:
        1. If momentum is standard, calculate the optimal 'limit_price' entry on a micro-pullback (e.g., to the VWAP) for a better risk/reward.
        2. If momentum is EXPLOSIVE and the trend is running away, DO NOT wait for a deep pullback. Calculate a 'limit_price' AT OR SLIGHTLY BEYOND the current market price ($${currentPrice}) to guarantee the order fills immediately. Do not miss the trade trying to save a few pennies.
        
        CRITICAL: Calculate a dynamic 'sl_price' (Stop Loss) safely below major Macro structural support. You MUST factor in extreme local volatility and add a wide ATR buffer to your Stop Loss to prevent premature liquidation from market wicks.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 0.5 - 10.0,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'REVERSAL' && openTrade) {
        prompt = `
        CONTEXT AWARENESS REQUIRED: We are currently holding an open ${openTrade.side} position on ${asset} from an entry of $${openTrade.entry_price}. 
        The current floating PnL is ${openTrade.pnl_percent}%. Current market price is $${currentPrice}.
        
        A CONTRARY ${signal} signal just flashed.
        
        ${mtfaContext}
        ${microstructureContext}
        ${memoryContext}
        
        CRITICAL WARNING: You must VETO this new signal UNLESS the MACRO timeframe or Order Book shows a massive, undeniable structural trend reversal that guarantees our current ${openTrade.side} position is doomed. Pay close attention to CVD divergence, Order Book walls, and your Shadow Portfolio memory to validate the reversal.
        If it is just temporary chop, VETO the signal to hold our original ${openTrade.side} position and let the mathematical Stop Loss handle risk.
        
        THE REVERSAL QUALITY THRESHOLD (OPPORTUNITY COST):
        Assume the current open position is a premium, high-conviction setup. You are STRICTLY FORBIDDEN from abandoning it for a mediocre trade. 
        To APPROVE a reversal, the new setup MUST be undeniably superior:
        1. Command an elite Conviction Score of 85 to 95+. Do not throw away an open trade for an 80 or 75 conviction scalp.
        2. Offer a massive Take Profit distance (an exceptional Risk/Reward ratio).
        If the new setup is weak, looks like chop, or offers poor Risk/Reward, you MUST choose 'VETO' and let the original position's Stop Loss handle the risk.
        
        If you APPROVE the reversal, calculate the optimal limit order entry price to execute the flip, and provide new Macro S/R targets for 'tp_price' and 'sl_price'.
        
        CRITICAL: Calculate a dynamic 'sl_price' (Stop Loss) safely beyond major Macro structural support. You MUST factor in extreme local volatility and add a wide ATR buffer to your Stop Loss to prevent premature liquidation from market wicks.
        
        ${sizingContext}
        `;
        expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "tp_price": [Macro Take Profit Number],\n  "sl_price": [Macro Stop Loss Number],\n  "size_multiplier": 0.5 - 10.0,\n  "reasoning": "string"\n}`;
    
    } else if (mode === 'EMERGENCY') {
        prompt = `
        URGENT: An open ${strategy} trade on ${asset} is currently down ${(pnlPercent * 100).toFixed(2)}%. Current price is $${currentPrice}.
        
        ${mtfaContext}
        ${microstructureContext}
        ${memoryContext}
        
        Has the core Macro market regime structurally failed? Look at the X-Ray Data: Is CVD showing aggressive institutional dumping against us? Are massive order book walls building to block our recovery? Is the Basis Premium collapsing? Did your recent Shadow Portfolio vetos warn you about this exact trap?
        Should we HOLD and wait for the physical exchange Stop Loss, or execute an emergency MARKET_CLOSE right now to prevent total destruction?
        `;
        expectedOutput = `{\n  "action": "HOLD" | "MARKET_CLOSE",\n  "conviction_score": 0-100,\n  "reasoning": "string"\n}`;

    } else if (mode === 'MANUAL_REVIEW' && openTrade) {
        prompt = `
        MANUAL SNIPER / TRIPWIRE REVIEW INITIATED: A tactical re-evaluation of this open ${openTrade.side} position on ${asset} is required.
        Entry Price: $${openTrade.entry_price}. Current Price: $${currentPrice}. Floating PnL: ${(pnlPercent * 100).toFixed(2)}%.
        Current Active Targets - Take Profit: $${openTrade.tp_price || 'None'}, Stop Loss: $${openTrade.sl_price || 'None'}.
        
        ${mtfaContext}
        ${microstructureContext}
        ${memoryContext}
        
        CRITICAL DIRECTIVES FOR ACTIVE MANAGEMENT (THE HYBRID TRIPWIRE PROTOCOL):
        You MUST evaluate the current momentum AND the X-Ray Data (CVD, Imbalance, Premium) to decide how aggressively to protect this profit. You must choose 'ADJUST_LIMITS' and do one of the following:
        
        1. THE BREAKEVEN STOP (If strong continuation is highly probable): If the micro-trend is incredibly strong, volume is accelerating, and X-Ray Data supports the move, move the 'sl_price' JUST PAST the Entry Price ($${openTrade.entry_price}) to guarantee a risk-free trade, but leave the 'tp_price' alone (or trail it slightly) to let the runner breathe.
        
        2. THE AGGRESSIVE TRAIL / SQUEEZE TRAP (If momentum is fading or X-Ray Data shows a trap): If CVD is diverging against us, a massive resistance wall just appeared on the Order Book, or you suspect an institutional liquidity hunt based on your Shadow Portfolio memory, aggressively hike the 'sl_price' deep into profit territory to lock in 50%-75% of the current gains. If a squeeze or flash crash is imminent based on the X-Ray Data, FRONT-RUN THE TARGET by bringing the 'tp_price' much closer to the current price to secure the win immediately.
        
        3. If the macro structure has completely failed against us and CVD proves it, choose MARKET_CLOSE.
        
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