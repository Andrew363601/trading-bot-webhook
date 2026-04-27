// hermes-brain.js (Now powered by Gemini 2.5 Pro)
import express from 'express';
import fs from 'fs';
import { buildRadarChartUrl } from './lib/discord-chart.js';

const app = express();
app.use(express.json());

const skillMemory = fs.readFileSync('./SKILL.md', 'utf-8');

// 🟢 THE FIX: Restored Discord functionality so the AI stops talking to itself in the void
async function sendDiscordAlert({ title, description, color, fields = [], imageUrl = null }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        const embed = { title, description, color, timestamp: new Date().toISOString() };
        if (fields.length > 0) embed.fields = fields;
        if (imageUrl) embed.image = { url: imageUrl };
        await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

app.post('/api/wake', async (req, res) => {
    // 🟢 THE FIX: Intercept the new telemetry objects sent by the Sniper
    const { asset, mode, message, openTrade, candles, indicators } = req.body;
    console.log(`[AGENT CORTEX] Awakened by Sniper. Asset: ${asset} | Mode: ${mode}`);
    
    res.status(200).json({ status: "Agent Awakened. Initiating analysis." });

    try {
        const mcpUrl = process.env.MCP_GATEWAY_URL;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!mcpUrl || !geminiKey) throw new Error("Missing MCP Gateway URL or Gemini API Key.");

        console.log(`[AGENT CORTEX] Pulling get_market_state tool...`);
        const stateResp = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset } })
        });
        const marketState = await stateResp.json();

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

        // 🟢 THE FIX: Build the radar chart using the new Candlestick logic and OpenTrade overlay
        let chartUrl = null;
        if (candles && indicators) {
            chartUrl = await buildRadarChartUrl({
                asset, candles, poc: indicators.macro_poc, upperNode: indicators.upper_macro_node, lowerNode: indicators.lower_macro_node,
                currentPrice: candles[candles.length - 1]?.close, openTrade
            });
        }

        // 🟢 THE FIX: Blast the decision logic straight to Discord!
        const isVeto = decisionJson.action === "VETO";
        await sendDiscordAlert({
            title: isVeto ? `🛡️ Agent VETO: ${asset}` : `🧠 Agent APPROVED: ${asset}`,
            description: `**Mode:** ${mode}\n**Reasoning:** _${decisionJson.reason || 'No rationale provided'}_`,
            color: isVeto ? 10038562 : 3447003, // Red for VETO, Blue for APPROVE
            imageUrl: chartUrl
        });

        if (!isVeto && decisionJson.price) {
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

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AGENT CORTEX] Online. Listening for Sniper flares on port ${PORT}`);
});