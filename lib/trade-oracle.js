// lib/trade-oracle.js

export async function evaluateTradeIdea({ mode, asset, strategy, signal, currentPrice, candles, pnlPercent = 0, marketType = 'FUTURES' }) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const recentCandles = candles.slice(-150);
      
      let prompt = "";
      let expectedOutput = "";

      if (mode === 'ENTRY') {
          // DYNAMIC MARKET CONTEXT
          const sizingContext = marketType === 'SPOT' 
            ? "Since this is a SPOT market, leverage is not applicable. If conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' (e.g., 1.5 for 50% more USD allocation). Otherwise, return 1.0."
            : "Since this is a FUTURES market, if conviction is exceptionally high (> 85), you may recommend a 'size_multiplier' to increase the leveraged position size (e.g., 1.5 for 50% more size). Otherwise, return 1.0.";

          prompt = `
          A ${signal} signal just flashed for ${asset} at a current market price of $${currentPrice} using the ${strategy} strategy.
          Analyze the recent 150 candles. Determine if this is a high-probability continuation/breakout, or a false signal into support/resistance.
          
          If this is a solid setup, DO NOT buy at market price. Calculate the optimal limit order entry price on a micro-pullback (e.g., VWAP, EMA, or recent support).
          
          ${sizingContext}
          `;
          expectedOutput = `{\n  "action": "APPROVE" | "VETO",\n  "conviction_score": 0-100,\n  "limit_price": [Optimal Entry Number],\n  "size_multiplier": 1.0 - 1.5,\n  "reasoning": "string"\n}`;
      } 
      else if (mode === 'EMERGENCY') {
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

      const resp = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`Gemini rejected: ${await resp.text()}`);

      const data = await resp.json();
      const cleanJsonString = data.candidates[0].content.parts[0].text;
      return JSON.parse(cleanJsonString);

    } catch (err) {
      console.error(`[ORACLE FAULT] ${asset}:`, err.message);
      return mode === 'ENTRY' ? { action: 'VETO', reasoning: 'Oracle timeout.' } : { action: 'HOLD', reasoning: 'Oracle timeout.' };
    }
}