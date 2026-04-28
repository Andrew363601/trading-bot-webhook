// hermes-brain.js (Now powered by Gemini 2.5 Pro)
import express from 'express';
import fs from 'fs';
import { buildRadarChartUrl } from './lib/discord-chart.js';
import { createClient } from '@supabase/supabase-js'; 

const app = express();
app.use(express.json());

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const skillMemory = fs.readFileSync('./SKILL.md', 'utf-8');

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
    const { asset, mode, message, openTrade, candles, indicators, macro_tf, trigger_tf, execution_mode, strategy_id, version, previous_thesis } = req.body;
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
            body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset, macro_tf, trigger_tf } })
        });
        const marketState = await stateResp.json();

        console.log(`[AGENT CORTEX] X-Ray Data acquired. Booting Gemini inference engine...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${geminiKey}`;
        
        const payload = {
            systemInstruction: { parts: [{ text: skillMemory }] },
            contents: [{
                role: "user",
                parts: [{ text: `ALERT: ${message}\n\nYOUR PREVIOUS THESIS: ${previous_thesis || "None."}\n\nACTIVE OPEN TRADE: ${openTrade ? JSON.stringify(openTrade) : "None"}\n\nLIVE MULTI-TF MARKET STATE:\n${JSON.stringify(marketState, null, 2)}\n\nAnalyze the CVD and Level 2 Intent. Do not let micro 5M absorption trick you. CRITICAL: If you already have an ACTIVE OPEN TRADE that matches the signal direction, output action "HOLD" to let it run and prevent double entries. Update your working thesis. Determine if you APPROVE, REVERSE, VETO, HOLD, CLOSE, or set a VIRTUAL_TRAP. Output ONLY raw, valid JSON.` }]
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
        console.log(`[AGENT RATIONALE]:`, decisionJson.working_thesis || "Executing protocol.");

        if (decisionJson.working_thesis) {
            const updatePayload = { active_thesis: decisionJson.working_thesis };
            
            if (decisionJson.action === "VIRTUAL_TRAP" && decisionJson.trap_price && decisionJson.side) {
                updatePayload.trap_side = decisionJson.side;
                updatePayload.trap_price = decisionJson.trap_price;
                updatePayload.trap_tp_price = decisionJson.trap_tp_price || decisionJson.tp_price; 
                updatePayload.trap_sl_price = decisionJson.trap_sl_price || decisionJson.sl_price;
                updatePayload.trap_expires_at = new Date(Date.now() + 3600000).toISOString(); 
                console.log(`[AGENT CORTEX] 👻 GHOST ORDER SET: ${decisionJson.side} at $${decisionJson.trap_price} | TP: $${updatePayload.trap_tp_price} | SL: $${updatePayload.trap_sl_price}`);
            }

            await supabase.from('strategy_config')
                .update(updatePayload)
                .eq('strategy', strategy_id || 'MANUAL')
                .eq('asset', asset);
                
            if (openTrade) {
                const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const newLogEntry = `\n[${timeStr}Z] [${decisionJson.action}]: ${decisionJson.working_thesis}`;
                const rollingLedger = (openTrade.reason || '') + newLogEntry;
                
                await supabase.from('trade_logs')
                    .update({ reason: rollingLedger })
                    .eq('id', openTrade.id);
            }
        }

        let chartUrl = null;
        if (candles && indicators) {
            chartUrl = await buildRadarChartUrl({
                asset, candles, poc: indicators.macro_poc, upperNode: indicators.upper_macro_node, lowerNode: indicators.lower_macro_node,
                currentPrice: candles[candles.length - 1]?.close, openTrade
            });
        }

        const isVeto = decisionJson.action === "VETO";
        const isReversal = decisionJson.action === "REVERSE";
        const isTrap = decisionJson.action === "VIRTUAL_TRAP";
        const isHold = decisionJson.action === "HOLD"; 
        const isClose = decisionJson.action === "CLOSE"; // 🟢 Added CLOSE logic
        
        let alertTitle = `🧠 Agent APPROVED: ${asset}`;
        let alertColor = 3447003;
        
        if (isVeto) {
            alertTitle = `🛡️ Agent VETO: ${asset}`;
            alertColor = 10038562;
        } else if (isReversal) {
            alertTitle = `🔥 Agent REVERSED: ${asset}`;
            alertColor = 15548997; 
        } else if (isTrap) {
            alertTitle = `👻 Agent GHOST ORDER SET: ${asset}`;
            alertColor = 10181046; 
        } else if (isHold) {
            alertTitle = `🛡️ Agent HOLDING: ${asset}`;
            alertColor = 11184810; 
        } else if (isClose) {
            alertTitle = `🛑 Agent CLOSED: ${asset}`; // 🟢 Specific alert for closing
            alertColor = 16753920; 
        }

        await sendDiscordAlert({
            title: alertTitle,
            description: `**Conviction Score:** ${decisionJson.conviction_score || 'N/A'}/100\n**Action:** ${decisionJson.action}\n\n**Working Thesis:**\n_${decisionJson.working_thesis || 'No thesis provided'}_`,
            color: alertColor, 
            imageUrl: chartUrl
        });

        // 🟢 THE FIX: Included "CLOSE" so it physically hits the execution endpoint
        const isActionableExecution = decisionJson.action === "APPROVE" || decisionJson.action === "REVERSE" || decisionJson.action === "CLOSE";
        
        if (isActionableExecution) {
            console.log(`[AGENT CORTEX] Triggering execute_order tool for action: ${decisionJson.action}`);
            
            decisionJson.symbol = asset;
            decisionJson.execution_mode = execution_mode || 'PAPER';
            decisionJson.strategy_id = strategy_id || 'MANUAL';
            decisionJson.version = version || 'v1.0';
            decisionJson.working_thesis = decisionJson.working_thesis || 'Autonomous Execution';
            
            // 🟢 Tag 'CLOSE' explicitly so execute-trade-mcp.js forces the exit loop
            decisionJson.reason = decisionJson.action === "CLOSE" ? `[CLOSE] ${decisionJson.working_thesis}` : decisionJson.working_thesis; 

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