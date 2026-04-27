// hermes-brain.js (Now powered by Gemini 2.5 Pro)
import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json());

// 1. Load the Master Policy (The Agent's Memory)
const skillMemory = fs.readFileSync('./SKILL.md', 'utf-8');

// 2. The Flare Listener (Sniper pings this endpoint)
app.post('/api/wake', async (req, res) => {
    const { asset, mode, message } = req.body;
    console.log(`[AGENT CORTEX] Awakened by Sniper. Asset: ${asset} | Mode: ${mode}`);
    
    // Immediately respond to the Sniper so the WebSocket loop doesn't hang
    res.status(200).json({ status: "Agent Awakened. Initiating analysis." });

    try {
        const mcpUrl = process.env.MCP_GATEWAY_URL;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!mcpUrl || !geminiKey) throw new Error("Missing MCP Gateway URL or Gemini API Key.");

        // Step 1: Call the MCP Gateway to get the X-Ray Data
        console.log(`[AGENT CORTEX] Pulling get_market_state tool...`);
        const stateResp = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset } })
        });
        const marketState = await stateResp.json();

        // Step 2: Handoff to Gemini 2.5 Pro
        console.log(`[AGENT CORTEX] X-Ray Data acquired. Booting Gemini inference engine...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${geminiKey}`;
        
        const payload = {
            systemInstruction: { parts: [{ text: skillMemory }] },
            contents: [{
                role: "user",
                parts: [{ text: `ALERT: ${message}\n\nLIVE MARKET STATE:\n${JSON.stringify(marketState, null, 2)}\n\nEvaluate this data against your SKILL.md directives. If you approve the setup, output a JSON object with the exact parameters for the 'execute_order' tool. If the setup is flawed, output {"action": "VETO", "reason": "Your rationale"}. Output ONLY raw, valid JSON.` }]
            }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const llmResp = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!llmResp.ok) throw new Error(`Gemini API Error: ${await llmResp.text()}`);

        const llmData = await llmResp.json();
        let agentOutput = llmData.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
        const decisionJson = JSON.parse(agentOutput);

        console.log(`[AGENT CORTEX] Decision Matrix:`, decisionJson.action || "APPROVE_EXECUTION");
        console.log(`[AGENT RATIONALE]:`, decisionJson.reason || "Executing protocol.");

        // Step 3: Call the Execution Tool if Approved
        if (decisionJson.action !== "VETO" && decisionJson.price) {
            console.log(`[AGENT CORTEX] Triggering execute_order tool...`);
            await fetch(mcpUrl, {
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'execute_order', arguments: decisionJson })
            });
        }

    } catch (error) {
        console.error(`[AGENT FATAL]:`, error.message);
    }
});

// 🟢 THE FIX: Bound to 0.0.0.0 to prevent Render Crash Loops
const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AGENT CORTEX] Online. Listening for Sniper flares on port ${PORT}`);
});