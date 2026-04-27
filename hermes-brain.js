// hermes-brain.js
import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json());

// 1. Load the Master Policy
const skillMemory = fs.readFileSync('./SKILL.md', 'utf-8');

// 2. The Flare Listener (Sniper pings this endpoint)
app.post('/api/wake', async (req, res) => {
    const { asset, mode, message } = req.body;
    console.log(`[HERMES CORTEX] Awakened by Sniper. Asset: ${asset} | Mode: ${mode}`);
    
    // Immediately respond to the Sniper so the WebSocket loop doesn't hang
    res.status(200).json({ status: "Agent Awakened. Initiating analysis." });

    try {
        const mcpUrl = process.env.MCP_GATEWAY_URL;
        const openRouterKey = process.env.OPENROUTER_API_KEY;

        if (!mcpUrl || !openRouterKey) throw new Error("Missing MCP Gateway URL or OpenRouter API Key.");

        // Step 1: Call the MCP Gateway to get the X-Ray Data
        console.log(`[HERMES CORTEX] Pulling get_market_state tool...`);
        const stateResp = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset } })
        });
        const marketState = await stateResp.json();

        // Step 2: Handoff to Nous Hermes 3 (405B Parameters) via OpenRouter
        console.log(`[HERMES CORTEX] X-Ray Data acquired. Booting inference engine...`);
        const llmResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openRouterKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nousresearch/hermes-3-llama-3.1-405b", 
                messages: [
                    { role: "system", content: skillMemory },
                    { role: "user", content: `ALERT: ${message}\n\nLIVE MARKET STATE:\n${JSON.stringify(marketState, null, 2)}\n\nEvaluate this data against your SKILL.md directives. If you approve the setup, output a JSON object with the exact parameters for the 'execute_order' tool. If the setup is flawed, output {"action": "VETO", "reason": "Your rationale"}. Output ONLY raw, valid JSON.` }
                ]
            })
        });

        const llmData = await llmResp.json();
        let agentOutput = llmData.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
        const decisionJson = JSON.parse(agentOutput);

        console.log(`[HERMES CORTEX] Decision Matrix:`, decisionJson.action || "APPROVE_EXECUTION");
        console.log(`[HERMES RATIONALE]:`, decisionJson.reason || "Executing protocol.");

        // Step 3: Call the Execution Tool if Approved
        if (decisionJson.action !== "VETO" && decisionJson.price) {
            console.log(`[HERMES CORTEX] Triggering execute_order tool...`);
            await fetch(mcpUrl, {
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'execute_order', arguments: decisionJson })
            });
        }

    } catch (error) {
        console.error(`[HERMES FATAL]:`, error.message);
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`[HERMES CORTEX] Online. Listening for Sniper flares on port ${PORT}`);
});