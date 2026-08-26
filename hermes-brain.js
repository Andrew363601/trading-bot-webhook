// hermes-brain.js 
import express from 'express';
import fs from 'fs';
import { buildRadarChartUrl } from './lib/discord-chart.js';
import { createClient } from '@supabase/supabase-js'; 
import { recordUsage } from './lib/usage-meter.js';
import { getActiveModel } from './lib/model-router.js';

const app = express();
app.use(express.json());

import WebSocket from 'ws'; 

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { 
    global: { WebSocket: WebSocket },
    realtime: { transport: WebSocket }
  }
);

async function logAgentActivity(tenant_id, agent_name, asset, log_message, log_type = 'INFO') {
    try {
        const { error } = await supabase.from('agent_session_logs').insert([
            { tenant_id, agent_name, asset, log_message, log_type, timestamp: new Date().toISOString() }
        ]);
        if (error) {
            console.error("[HERMES BRAIN LOGGING ERROR]: Failed to log agent activity:", error.message);
        }
    } catch (err) {
        console.error("[HERMES BRAIN LOGGING FATAL]: Uncaught error in logAgentActivity:", err.message);
    }
}

const gatewayFetch = async (tool, args) => {
  const mcpUrl = process.env.MCP_GATEWAY_URL;
  if (!mcpUrl) throw new Error('MCP_GATEWAY_URL not configured');
  // Derive base URL: strip /mcp/execute suffix if present
  const gatewayBase = mcpUrl.replace(/\/mcp\/execute$/, '');
  const resp = await fetch(`${gatewayBase}/mcp/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Gateway returned ${resp.status}`);
  return data.result || data;
};

const skillMemory = fs.readFileSync('./SKILL.md', 'utf-8');

// 🛡️ DEFENSIVE GUARD: tripwire/trail values must be decimal fractions (0.005 = 0.5%).
// If the AI accidentally outputs percentage integers (e.g., 5 meaning 5%), divide by 100.
// Clamp to a safe range: 0.0001 (0.01%) to 0.20 (20%).
function normalizePercent(val, label) {
    if (val === undefined || val === null) return val;
    let num = parseFloat(val);
    if (isNaN(num)) return undefined;
    if (num > 1.0 && num <= 100) {
        console.warn(`[AGENT CORTEX] ⚠️ ${label} value ${num} appears to be a percentage integer. Dividing by 100 → ${(num/100).toFixed(6)}`);
        num = num / 100;
    }
    if (num > 0.20) {
        console.warn(`[AGENT CORTEX] ⚠️ ${label} value ${num} exceeds max (20%). Clamping to 0.20.`);
        num = 0.20;
    }
    if (num < 0.0001 && num !== 0) {
        console.warn(`[AGENT CORTEX] ⚠️ ${label} value ${num} below min (0.01%). Clamping to 0.0001.`);
        num = 0.0001;
    }
    return num;
}

async function sendDiscordAlert(tenant_id, { title, description, color, fields = [], imageUrl = null, useNexusWebhook = false }) {
    const { data: settings, error: settingsError } = await supabase
        .from('tenant_settings')
        .select('notification_webhook_url, notification_nexus_webhook_url')
        .eq('tenant_id', tenant_id)
        .single();

    if (settingsError) {
        console.error("[DISCORD ALERT ERROR]: Failed to fetch webhook URL for tenant:", settingsError.message);
        return;
    }
    // For Nexus agent messages, prefer the dedicated Nexus webhook; fall back to alert webhook
    let webhookUrl = settings?.notification_webhook_url;
    if (useNexusWebhook && settings?.notification_nexus_webhook_url) {
        webhookUrl = settings.notification_nexus_webhook_url;
    }

    if (!webhookUrl) {
        console.warn("[DISCORD ALERT WARNING]: No Discord webhook URL configured for tenant", tenant_id);
        return;
    }
    try {
        const embed = { title, description, color, timestamp: new Date().toISOString() };
        if (fields.length > 0) embed.fields = fields;
        if (imageUrl) embed.image = { url: imageUrl };
        await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
    } catch (e) { console.error("Discord Alert Failed:", e.message); }
}

// 🟢 Asset metrics helper: maps symbol → multiplier & tickSize
const getAssetMetrics = (symbol) => {
    let multiplier = 1.0;
    let tickSize = 0.01;
    if (symbol.includes('ETP') || symbol.includes('ETH')) { multiplier = 0.1; tickSize = 0.50; }
    else if (symbol.includes('BIT') || symbol.includes('BIP') || symbol.includes('BTC')) { multiplier = 0.01; tickSize = 5.00; }
    else if (symbol.includes('SLP') || symbol.includes('SOL')) { multiplier = 5.0; tickSize = 0.01; }
    else if (symbol.includes('DOP') || symbol.includes('DOGE')) { multiplier = 1000.0; tickSize = 0.0001; }
    else if (symbol.includes('LCP') || symbol.includes('LTC')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('AVP') || symbol.includes('AVAX')) { multiplier = 1.0; tickSize = 0.01; }
    else if (symbol.includes('LNP') || symbol.includes('LINK')) { multiplier = 1.0; tickSize = 0.001; }
    return { multiplier, tickSize };
};

// 🟢 Contract cost calculator: position value, fees, min R:R
function buildContractCostBlock(asset, qty, price, feeRate) {
    const { multiplier } = getAssetMetrics(asset);
    const positionValue = price * qty * multiplier;
    const rate = feeRate || 0.0008;
    const entryFee = positionValue * rate;
    const exitFee = positionValue * rate;
    const roundTrip = entryFee + exitFee;
    const minRR = roundTrip > 0 ? (roundTrip / positionValue) * 2 : 0.001;
    return {
        text: `\n--- CONTRACT COST ANALYSIS ---\nAsset: ${asset}\nContracts: ${qty} | Multiplier: ${multiplier}x\nPosition Value: $${positionValue.toFixed(2)}\nEst. Entry Fee (${(rate * 100).toFixed(3)}%): $${entryFee.toFixed(4)}\nEst. Exit Fee: $${exitFee.toFixed(4)}\nRound-Trip Cost: $${roundTrip.toFixed(4)}\nMinimum R:R to Beat Fees: > ${minRR.toFixed(3)}`,
        roundTripCost: roundTrip,
        feeRate: rate,
        multiplier
    };
}

// 🟢 THE WAKE ENDPOINT (Trade Origination & Management)
app.post('/api/wake', async (req, res) => {
    const { tenant_id, asset, mode, message, openTrade, candles, indicators, macro_tf, trigger_tf, execution_mode, strategy_id, version, previous_thesis, qty, memoryIds } = req.body;
    
    // Track Hermes API usage
    await recordUsage(tenant_id, 'HERMES_API_CALL', 1);

    await logAgentActivity(tenant_id, "Agent Cortex", asset, `Awakened. Mode: ${mode}. Initial message: ${message.substring(0, 100)}...`, "AGENT_AWAKENED");
    console.log(`[AGENT CORTEX] Awakened by Sniper. Tenant: ${tenant_id} | Asset: ${asset} | Mode: ${mode}`);
    
    // 🟢 THESIS INTEGRITY: Check for open trades & determine if we should re-evaluate or block
    let activeOpenTrade = null;
    let isReEvaluation = false;
    let tenantAgentSettings = {};
    
    const { data: existingOpenTrades, error: openTradeError } = await supabase
        .from('trade_logs')
        .select('id, side, entry_price, tp_price, sl_price, qty, strategy_id, reason')
        .eq('tenant_id', tenant_id)
        .eq('symbol', asset)
        .is('exit_price', null);

    if (openTradeError) {
        console.error("[AGENT CORTEX ERROR]: Failed to check for open trades:", openTradeError.message);
        await logAgentActivity(tenant_id, "Agent Cortex", asset, `Error checking for open trades: ${openTradeError.message}`, "ERROR");
    }

    if (existingOpenTrades && existingOpenTrades.length > 0) {
        activeOpenTrade = existingOpenTrades[0];
        
        // Check if agent re-evaluation is enabled for this tenant
        const { data: agentSettings } = await supabase
            .from('tenant_settings')
            .select('agent_open_trade_enabled, agent_open_trade_reverse, agent_open_trade_close, agent_open_trade_adjust_tp_sl, agent_open_trade_tripwire_adjust, agent_taker_fee_rate')
            .eq('tenant_id', tenant_id)
            .single();
        
        tenantAgentSettings = agentSettings || {};
        
        if (tenantAgentSettings.agent_open_trade_enabled && mode === "ENTRY") {
            isReEvaluation = true;
            console.log(`[AGENT CORTEX] 🔄 Re-evaluation mode enabled for ${asset} open trade.`);
            await logAgentActivity(tenant_id, "Agent Cortex", asset, `Re-evaluation mode active for existing ${activeOpenTrade.side} position.`, "RE_EVALUATION");
        } else if (mode === "ENTRY") {
            const conflictMessage = `THESIS CONFLICT: Agent Cortex detected an active ${activeOpenTrade.side} position for ${asset} at $${activeOpenTrade.entry_price}. New entry signals or virtual traps will be ignored. Focus on managing the existing position.`;
            await logAgentActivity(tenant_id, "Agent Cortex", asset, conflictMessage, "THESIS_CONFLICT");
            return res.status(200).json({
                status: "Conflict Detected",
                message: conflictMessage,
                action_required: "MANAGE_EXISTING_POSITION",
                open_trade_details: activeOpenTrade
            });
        }
    }
    
    res.status(200).json({ status: "Agent Awakened. Initiating analysis." });

    try {
        const mcpUrl = process.env.MCP_GATEWAY_URL;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!mcpUrl || !geminiKey) throw new Error("Missing MCP Gateway URL or Gemini API Key.");

        console.log(`[AGENT CORTEX] Pulling X-Ray Telemetry & Native Institutional Intent...`);
        
        // Fetch MCP tool schemas for function-calling
        let toolSchemas = {};
        try {
          const gatewayUrl = process.env.MCP_GATEWAY_URL;
          if (gatewayUrl) {
            // Derive base URL: strip /mcp/execute suffix if present
            const gatewayBase = gatewayUrl.replace(/\/mcp\/execute$/, '');
            const toolsResp = await fetch(`${gatewayBase}/mcp/tools`).catch(() => null);
            if (toolsResp?.ok) {
              const toolsData = await toolsResp.json();
              toolSchemas = toolsData.tools || {};
              console.log(`[AGENT CORTEX] Loaded ${Object.keys(toolSchemas).length} tool schemas from gateway`);
            } else {
              console.warn(`[AGENT CORTEX] Tool schema fetch returned ${toolsResp?.status || 'no response'} — tools will not be available to the LLM`);
            }
          }
        } catch (e) {
          console.warn('[AGENT CORTEX] Tool schema fetch failed:', e.message);
        }

        // 🟢 THE UPGRADE: Fetch market state AND daily PnL in parallel
        const [stateResp, pnlResp] = await Promise.all([
            fetch(mcpUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset, macro_tf, trigger_tf, tenant_id } })
            }).catch(() => ({ json: () => ({ error: "Market State offline" }) })),
            fetch(mcpUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'get_daily_pnl', arguments: { tenant_id, execution_mode: execution_mode || (mode === 'ENTRY' ? 'PAPER' : null) } })
            }).catch(() => ({ json: () => ({ result: { total_pnl: 0, mode_pnl: 0, target: 1000, remaining_to_target: 1000 } }) }))
        ]);

        const marketState = await stateResp.json();

        // Fetch tenant's daily profit target for the fallback
        let defaultTarget = 1000;
        try {
            const { data: settings } = await supabase
                .from('tenant_settings')
                .select('daily_roi_target_usd')
                .eq('tenant_id', tenant_id)
                .single();
            if (settings?.daily_roi_target_usd) {
                defaultTarget = parseFloat(settings.daily_roi_target_usd);
            }
        } catch (e) {}

        const dailyPnl = (await pnlResp.json()).result || { total_pnl: 0, target: defaultTarget, remaining_to_target: defaultTarget };

        // 🟢 THE FIX: Fetch candles for chart generation if not provided in request
        if (!candles || !indicators) {
            try {
                const chartResp = await fetch(mcpUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tool: 'get_chart_data', arguments: { symbol: asset, timeframe: trigger_tf || 'FIVE_MINUTE', count: 50 } })
                }).catch(() => ({ json: () => ({}) }));
                const chartData = await chartResp.json();
                if (chartData?.candles) candles = chartData.candles;
                if (chartData?.indicators) indicators = chartData.indicators;
            } catch (e) {
                console.warn("[AGENT CORTEX] Chart data fetch failed, proceeding without chart image.");
            }
        }

        console.log(`[AGENT CORTEX] Data acquired. Boot LLM inference engine...`);
        const activeModel = await getActiveModel(supabase);

        // 🆕 Build tool declarations from gateway schemas
        const toolDefinitions = Object.entries(toolSchemas).map(([name, def]) => ({
          name,
          description: `${def.description || ''}${def.timeframe ? ` [${def.timeframe.toUpperCase()} TIMEFRAME]` : ''}${def.tier ? ` (Tier ${def.tier})` : ''}`,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(def.parameters || {}).map(([k, v]) => [k, {
                type: 'string',
                description: typeof v === 'string' ? String(v) : String(v)
              }])
            ),
            required: Object.keys(def.parameters || {}).slice(0, 1)
          }
        }));

        // Fetch tenant risk profile for AI context
        let riskContext = '';
        let runningBalance = null;
        try {
            const { data: settings } = await supabase
                .from('tenant_settings')
                .select('account_balance_usd, risk_per_trade_percent, max_position_size_usd, max_leverage, max_daily_loss_usd, max_concurrent_trades')
                .eq('tenant_id', tenant_id)
                .single();

            // Compute running balance from all-time realized PnL for the current mode
            if (settings) {
                const mode = execution_mode || 'PAPER';
                const { data: allTrades } = await supabase
                    .from('trade_logs')
                    .select('pnl')
                    .eq('tenant_id', tenant_id)
                    .eq('execution_mode', mode)
                    .not('pnl', 'is', null);
                const totalRealizedPnl = (allTrades || []).reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
                runningBalance = (parseFloat(settings.account_balance_usd || 5000) + totalRealizedPnl).toFixed(2);

                riskContext = `\n\n--- RISK PROFILE ---\nAccount Balance: $${runningBalance}\nRisk Per Trade: ${settings.risk_per_trade_percent || 'Not set'}%\nMax Position Size: $${settings.max_position_size_usd || 'Not set'}\nMax Leverage: ${settings.max_leverage || 'Not set'}x\nMax Daily Loss: $${settings.max_daily_loss_usd || 'Not set'}\nMax Concurrent Trades: ${settings.max_concurrent_trades || 'Not set'}`;
            }
        } catch (e) {
            console.warn("[AGENT CORTEX] Could not fetch risk profile:", e.message);
        }
        
        // 🟢 SELF-ADJUSTMENT CONTEXT: Inject current strategy parameters so
        // the AI knows the current values before deciding to UPDATE_PARAMS.
        let currentParamsText = '';
        try {
            const { data: stratConfig } = await supabase
                .from('strategy_config')
                .select('parameters')
                .eq('tenant_id', tenant_id)
                .eq('asset', asset)
                .eq('strategy', strategy_id)
                .single();
            if (stratConfig?.parameters) {
                currentParamsText = `\n\n--- CURRENT STRATEGY PARAMETERS ---\n${JSON.stringify(stratConfig.parameters, null, 2)}\n\nThese are the current values. If you use UPDATE_PARAMS, you only need to include the keys you want to change. Everything else stays as-is.\n`;
            }
        } catch (e) {
            console.warn("[AGENT CORTEX] Could not fetch strategy params:", e.message);
        }
        
        let instructionText = `ALERT: ${message}${currentParamsText}\n\nYOUR PREVIOUS THESIS: ${previous_thesis || "None."}\n\nACTIVE OPEN TRADE: ${openTrade ? JSON.stringify(openTrade) : "None"}\n\n`;
        
        // 🟢 RE-EVALUATION MODE: Inject enriched open trade management context
        if (isReEvaluation && activeOpenTrade) {
            // Calculate unrealized PnL from market state
            const currentPrice = marketState?.result?.current_price || marketState?.result?.price || (candles && candles.length > 0 ? candles[candles.length - 1].close : 0);
            const { multiplier } = getAssetMetrics(asset);
            const tradeQty = parseFloat(activeOpenTrade.qty) || parseFloat(qty) || 1;
            const entryPrice = parseFloat(activeOpenTrade.entry_price) || 0;
            const currentVal = currentPrice * tradeQty * multiplier;
            const entryVal = entryPrice * tradeQty * multiplier;
            const unrealizedPnl = activeOpenTrade.side === 'BUY' ? currentVal - entryVal : entryVal - currentVal;
            
            const feeRate = parseFloat(tenantAgentSettings.agent_taker_fee_rate) || 0.0008;
            const { text: costBlock, roundTripCost } = buildContractCostBlock(asset, tradeQty, currentPrice, feeRate);
            
            let allowedActions = ['"HOLD"'];
            if (tenantAgentSettings.agent_open_trade_close) allowedActions.push('"CLOSE"');
            if (tenantAgentSettings.agent_open_trade_reverse) allowedActions.push('"REVERSE"');
            if (tenantAgentSettings.agent_open_trade_adjust_tp_sl) allowedActions.push('"ADJUST_TP_SL"');
            if (tenantAgentSettings.agent_open_trade_tripwire_adjust) allowedActions.push('"UPDATE_TRIPWIRE"');
            
            instructionText += `
--- ACTIVE TRADE RE-EVALUATION MODE ---
You have an ACTIVE ${activeOpenTrade.side} position for ${asset}.

📊 CURRENT POSITION STATE:
- Entry Price: $${entryPrice}
- Current Price: ~$${currentPrice}
- Unrealized PnL: $${unrealizedPnl.toFixed(2)}
- Current TP: ${activeOpenTrade.tp_price ? '$' + activeOpenTrade.tp_price : 'Not set'}
- Current SL: ${activeOpenTrade.sl_price ? '$' + activeOpenTrade.sl_price : 'Not set'}

You MAY NOT open a new position in the same direction. Instead, choose ONE action from:
${allowedActions.join(', ')}

Action Details:
1. "HOLD" — Update your working thesis. Let the existing trade play out.
2. "CLOSE" — Close the position now. Capital preservation is valid.
3. "REVERSE" — Close current AND open opposite position.*
4. "ADJUST_TP_SL" — Provide new_tp_price and/or new_sl_price via the execute_order tool. The system will cancel old brackets and place new ones.
5. "UPDATE_TRIPWIRE" — Update the strategy's tripwire_percent and/or trail_step_percent directly in the strategy config DB. Sniper picks up changes on next sweep cycle.
6. "UPDATE_PARAMS" — Permanently update strategy parameters (SL distance, cooldown, TP targets) when 3+ same-pattern losses are confirmed by core memory. Use only for persistent structural issues.

*For REVERSE: system will wait 2s for bracket clearing between close and open.
*For UPDATE_TRIPWIRE: writes to strategy_config.parameters JSONB — takes effect immediately on next sweep.*

${costBlock}

CRITICAL: Factor the estimated $${roundTripCost.toFixed(4)} round-trip fee cost into your R:R. If your TP target doesn't meaningfully exceed fees + risk distance, CLOSE or HOLD are safer.

Output ONLY raw JSON. Include working_thesis explaining your market data analysis.
`;
        } else if (activeOpenTrade) {
            instructionText += `⚠️ CRITICAL: There is already an ACTIVE ${activeOpenTrade.side} trade open for ${asset} at $${activeOpenTrade.entry_price} (ID: ${activeOpenTrade.id}). You MUST NOT approve any new entry signals for ${asset}. Only manage the existing position — output HOLD, CLOSE, or adjust TP/SL if needed.\n\n`;
        }
        
        if (message.includes('CORE MEMORY (Past Lessons') && message.includes('Score:')) {
            instructionText += `\n\n--- SCORING CONTEXT ---\nThe 3 memories above are scored by: recency, PnL magnitude, regime match, LIVE weight, and loss bonus. The highest-score memory is the most relevant lesson for this exact moment. Use it as your primary reference when forming your thesis. Read each memory's thesis context to understand what was attempted before — then decide if this signal is the same pattern or a new one.\n\n`;
        }
        
        // Also inject contract cost analysis for ANY entry evaluation (new trades too)
        if (!isReEvaluation && qty && !activeOpenTrade) {
            const feeRate = parseFloat(tenantAgentSettings.agent_taker_fee_rate) || 0.0008;
            const costBlock = buildContractCostBlock(asset, parseFloat(qty), 0, feeRate);
            instructionText += `\n--- CONTRACT COST NOTE ---\nConfigured taker fee rate: ${(feeRate * 100).toFixed(3)}%. Factor estimated fees into R:R calculations.\n\n`;
        }
        
        // 🟢 DAILY PNL: Inject bankroll awareness data (mode-specific only — no cross-mode leakage)
        const modeLabel = execution_mode || 'PAPER';
        const displayPnl = dailyPnl.mode_pnl ?? (execution_mode === 'LIVE' ? dailyPnl.live_pnl : dailyPnl.paper_pnl);
        instructionText += `--- CURRENT DAILY PNL (${modeLabel}) ---\nPnL: $${displayPnl?.toFixed(2) || '0.00'} | Target: $${dailyPnl.target || 1000} | Remaining: $${dailyPnl.remaining_to_target || 1000}\n\n`;
        
        // 🟢 RISK PROFILE: Inject tenant risk boundaries
        instructionText += riskContext + '\n\n';

        // 🆕 TIMEFRAME AWARENESS
        instructionText += `
<TIMEFRAME_AWARENESS>
Your MACRO_TIMEFRAME is: ${macro_tf || 'ONE_HOUR'}
Your TRIGGER_TIMEFRAME is: ${trigger_tf || 'FIVE_MINUTE'}

When calling tools:
- Tier 1-3 (OI, funding, ETF flows, exchange reserves, options, macro sentiment): Use the MACRO_TIMEFRAME interval
- Tier 4-5 (CVD, taker ratio, orderbook depth, liquidation heatmap): Use the TRIGGER_TIMEFRAME interval

Pass the appropriate interval parameter with every call. The gateway timestamp will be used as-is.
</TIMEFRAME_AWARENESS>

`;
        
        instructionText += `--- LIVE MULTI-TF MARKET STATE ---\n${JSON.stringify(marketState, null, 2)}\n\n`;
        
        // 🟢 THE UPGRADE: Guiding Hermes to the native Intent Data
        if (mode === "TRIPWIRE_HIT") {
            instructionText += `THE HARVEST PROTOCOL IS ACTIVE. You are currently in profit and your Stop Loss is secured at Break-Even. Analyze the CVD, Level 2 Intent, and the Native Open Interest/Funding Rates in the derivatives_premium block. If the momentum is explosive and the runway is clear, output action "HOLD". If OI is dropping, absorption is failing, or funding is extremely skewed against you, output action "CLOSE" to harvest the profit immediately. Output ONLY raw, valid JSON.`;
        } else {
            instructionText += `Analyze the CVD, Level 2 Intent, and the Native Open Interest/Funding Rates in the derivatives_premium block. Do not let micro 5M absorption trick you. CRITICAL: If you already have an ACTIVE OPEN TRADE that matches the signal direction, output action "HOLD" to let it run and prevent double entries. Update your working thesis. Determine if you APPROVE, REVERSE, VETO, HOLD, CLOSE, or set a VIRTUAL_TRAP. Also review the CORE MEMORY block above. You MUST output sl_percent, tp_percent, tripwire_percent, and trail_step_percent values that match YOUR WORKING THESIS — the structured fields must match the analysis in your working_thesis text. Do not use strategy defaults; use what the market conditions demand. The system will update the strategy config and notify Discord. Output ONLY raw, valid JSON.`;
        }

        console.log(`[AGENT CORTEX] Starting function-calling loop with ${toolDefinitions.length} tools available`);
        // 🆕 AGENTIC FUNCTION-CALLING LOOP
        let maxToolCalls = 15;
        let toolCallCount = 0;
        let accumulatedMessages = [];
        let finalDecisionText = null;

        const llmCall = async (messages) => {
            let url, headers, body;

            if (activeModel.provider === 'openrouter') {
                const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
                url = `${baseUrl}/chat/completions`;
                headers = {
                    'Authorization': `Bearer ${activeModel.apiKey}`,
                    'Content-Type': 'application/json'
                };
                body = {
                    model: activeModel.model,
                    messages: [
                        { role: 'system', content: skillMemory },
                        ...messages
                    ],
                    tools: toolDefinitions.map(d => ({ type: 'function', function: d })),
                    tool_choice: 'auto'
                };
            } else {
                url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel.model}:generateContent?key=${activeModel.apiKey || geminiKey}`;
                headers = { 'Content-Type': 'application/json' };
                body = {
                    systemInstruction: { parts: [{ text: skillMemory + '\n\nYou have access to tools listed below. Call them when needed to inform your thesis. When you have enough information, output your final decision as a JSON object with action, working_thesis, and all trade parameters.' }] },
                    contents: messages.map(m => ({
                        role: m.role === 'tool' || m.role === 'function' ? 'function' : m.role,
                        parts: m.role === 'function'
                            ? [{ functionResponse: { name: m.name, response: { content: m.content } } }]
                            : (m.tool_calls ? [{ text: '' }] : [{ text: m.content || '' }])
                    })),
                    tools: [{ functionDeclarations: toolDefinitions.map(d => ({ ...d, parameters: { ...d.parameters, type: 'object' } })) }],
                };
            }

            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!resp.ok) throw new Error(`AI API Error (${activeModel.provider}): ${await resp.text()}`);
            const data = await resp.json();

            if (activeModel.provider === 'openrouter') {
                const msg = data.choices?.[0]?.message;
                if (msg?.tool_calls?.length > 0) {
                    return { type: 'tool_calls', tool_calls: msg.tool_calls };
                }
                return { type: 'text', content: msg?.content || '' };
            } else {
                const candidate = data.candidates?.[0];
                const part = candidate?.content?.parts?.[0];
                if (part?.functionCall) {
                    return {
                        type: 'tool_calls',
                        tool_calls: [{
                            id: part.functionCall.name,
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {})
                            }
                        }]
                    };
                }
                return { type: 'text', content: part?.text || '' };
            }
        };

        accumulatedMessages.push({ role: 'user', content: instructionText });

        let executeOrderCalledInLoop = false;

        while (toolCallCount < maxToolCalls) {
            const result = await llmCall(accumulatedMessages);

            if (result.type === 'text') {
                finalDecisionText = result.content;
                break;
            }

            if (result.type === 'tool_calls') {
                console.log(`[AGENT CORTEX] LLM called ${result.tool_calls.length} tool(s): ${result.tool_calls.map(tc => tc.function?.name || tc.id).join(', ')}`);
                for (const tc of result.tool_calls) {
                    const fnName = tc.function?.name || tc.id || '';

                    let fnArgs = {};
                    try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch(e) {}

                    // Flag if LLM called execute_order — prevents post-loop double-dispatch
                    if (fnName === 'execute_order') {
                        executeOrderCalledInLoop = true;
                        fnArgs.strategy_id = strategy_id || 'MANUAL';
                        fnArgs.execution_mode = execution_mode || 'PAPER';
                    }

                    fnArgs.tenant_id = tenant_id;
                    fnArgs.trade_id = activeOpenTrade?.id || null;

                    try {
                        const gatewayResult = await gatewayFetch(fnName, fnArgs);
                        const resultStr = typeof gatewayResult === 'string' ? gatewayResult : JSON.stringify(gatewayResult);
                        
                        if (activeModel.provider === 'openrouter') {
                            accumulatedMessages.push({
                                role: 'assistant',
                                content: null,
                                tool_calls: [{ id: tc.id, type: 'function', function: { name: fnName, arguments: JSON.stringify(fnArgs) } }]
                            });
                            accumulatedMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: resultStr.substring(0, 2000)
                            });
                        } else {
                            accumulatedMessages.push({
                                role: 'function',
                                name: fnName,
                                content: resultStr.substring(0, 2000)
                            });
                        }
                    } catch (e) {
                        const errStr = `Error: ${e.message}`;
                        if (activeModel.provider === 'openrouter') {
                            accumulatedMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: errStr
                            });
                        } else {
                            accumulatedMessages.push({ role: 'function', name: fnName, content: errStr });
                        }
                    }
                    toolCallCount++;
                }
                console.log(`[AGENT CORTEX] Tool call round ${toolCallCount}/${maxToolCalls} complete`);
            }
        }

        console.log(`[AGENT CORTEX] Function-calling loop complete after ${toolCallCount} tool calls. Extracting final decision.`);
        if (!finalDecisionText) {
            throw new Error('Agent did not produce a final decision within the tool call limit.');
        }

        let rawText = finalDecisionText;
        const firstBrace = rawText.indexOf('{');
        const lastBrace = rawText.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1) {
            rawText = rawText.substring(firstBrace, lastBrace + 1);
        } else {
            throw new Error("No valid JSON object found in agent response.");
        }
        
        const decisionJson = JSON.parse(rawText);

        console.log(`[AGENT CORTEX] Decision Matrix:`, decisionJson.action || "APPROVE_EXECUTION");
        console.log(`[AGENT RATIONALE]:`, decisionJson.working_thesis || "Executing protocol.");

        // 🟢 THE FIX: Log the reasoning to the persistent audit trail for the UI
        await logAgentActivity(tenant_id, "Agent Cortex", asset, `Analysis Complete. Action: ${decisionJson.action}. Rationale: ${decisionJson.working_thesis}`, "AGENT_DECISION");

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

            // 🟢 CORE MEMORY PARAMETER LEARNING: APPROVE/VETO/HOLD can adjust
            // tripwire_percent / trail_step_percent / sl_percent / tp_percent from past lessons even when
            // no trade is open. Lessons from closed trades apply to future entries.
            // IMPORTANT: Must merge with existing params — never replace the entire
            // parameters JSONB object or ALL other params (qty, leverage, ema, etc.)
            // get deleted.
            if (decisionJson.action === "APPROVE" || decisionJson.action === "VETO" || decisionJson.action === "HOLD") {
                let newTripwirePct = decisionJson.tripwire_percent;
                let newTrailStepPct = decisionJson.trail_step_percent;
                newTripwirePct = normalizePercent(newTripwirePct, 'Tripwire');
                newTrailStepPct = normalizePercent(newTrailStepPct, 'Trail step');
                let newSlPercent = normalizePercent(decisionJson.sl_percent, 'SL percent');
                let newTpPercent = normalizePercent(decisionJson.tp_percent, 'TP percent');

                if (newTripwirePct !== undefined || newTrailStepPct !== undefined || newSlPercent !== undefined || newTpPercent !== undefined) {
                    const { data: existingConfig } = await supabase
                        .from('strategy_config')
                        .select('id, parameters')
                        .eq('tenant_id', tenant_id)
                        .eq('strategy', strategy_id || 'MANUAL')
                        .eq('asset', asset)
                        .limit(1)
                        .maybeSingle();

                    if (existingConfig) {
                        const mergedParams = { ...(existingConfig.parameters || {}) };
                        if (newTripwirePct !== undefined) mergedParams.tripwire_percent = parseFloat(newTripwirePct);
                        if (newTrailStepPct !== undefined) mergedParams.trail_step_percent = parseFloat(newTrailStepPct);
                        if (newSlPercent !== undefined) mergedParams.sl_percent = parseFloat(newSlPercent);
                        if (newTpPercent !== undefined) mergedParams.tp_percent = parseFloat(newTpPercent);
                        updatePayload.parameters = mergedParams;
                        console.log(`[AGENT CORTEX] 🔄 Parameters merged via ${decisionJson.action}: ${Object.keys(mergedParams).length} total keys, sl=${mergedParams.sl_percent}, tp=${mergedParams.tp_percent}, tripwire=${mergedParams.tripwire_percent}, trail_step=${mergedParams.trail_step_percent}`);
                        
                        // 🟢 Discord notification when params change during APPROVE
                        await sendDiscordAlert(tenant_id, {
                            title: `🔄 Parameters Adjusted via ${decisionJson.action}: ${asset}`,
                            description: `**Strategy:** ${strategy_id || 'MANUAL'}\n**SL:** ${newSlPercent !== undefined ? (parseFloat(newSlPercent) * 100).toFixed(2) + '%' : 'Unchanged'}\n**TP:** ${newTpPercent !== undefined ? (parseFloat(newTpPercent) * 100).toFixed(2) + '%' : 'Unchanged'}\n**Tripwire:** ${newTripwirePct !== undefined ? (parseFloat(newTripwirePct) * 100).toFixed(2) + '%' : 'Unchanged'}\n**Trail Step:** ${newTrailStepPct !== undefined ? (parseFloat(newTrailStepPct) * 100).toFixed(2) + '%' : 'Unchanged'}\n**Thesis:** ${decisionJson.working_thesis}`,
                            color: 15844367
                        });
                    } else {
                        // No existing config found — create fresh params (edge case)
                        const freshParams = {};
                        if (newTripwirePct !== undefined) freshParams.tripwire_percent = parseFloat(newTripwirePct);
                        if (newTrailStepPct !== undefined) freshParams.trail_step_percent = parseFloat(newTrailStepPct);
                        if (newSlPercent !== undefined) freshParams.sl_percent = parseFloat(newSlPercent);
                        if (newTpPercent !== undefined) freshParams.tp_percent = parseFloat(newTpPercent);
                        updatePayload.parameters = freshParams;
                        console.log(`[AGENT CORTEX] ⚠️ No existing config found for ${asset}/${strategy_id}. Created fresh params.`);
                    }
                }
            }

            try {
                await supabase.from('strategy_config')
                    .update(updatePayload)
                    .eq('tenant_id', tenant_id)
                    .eq('strategy', strategy_id || 'MANUAL')
                    .eq('asset', asset);
            } catch (error) {
                console.error(`[SUPABASE ERROR] Failed to update strategy_config for ${asset}:`, error.message);
            }
                
            if (openTrade) {
                const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const newLogEntry = `\n[${timeStr}Z] [${decisionJson.action}]: ${decisionJson.working_thesis}`;
                const rollingLedger = (openTrade.reason || '') + newLogEntry;
                
                try {
                    await supabase.from('trade_logs')
                        .update({ reason: rollingLedger })
                        .eq('id', openTrade.id);
                } catch (error) {
                    console.error(`[SUPABASE ERROR] Failed to update trade_logs for ${asset}:`, error.message);
                }
            }
        }

        const isVeto = decisionJson.action === "VETO";
        const isReversal = decisionJson.action === "REVERSE";
        const isTrap = decisionJson.action === "VIRTUAL_TRAP";
        const isHold = decisionJson.action === "HOLD"; 
        const isClose = decisionJson.action === "CLOSE"; 

        let chartUrl = null;
        if (candles && indicators) {
            chartUrl = await buildRadarChartUrl({
                asset, candles, poc: indicators.macro_poc, upperNode: indicators.upper_macro_node, lowerNode: indicators.lower_macro_node,
                currentPrice: candles[candles.length - 1]?.close, openTrade,
                trapPrice: isTrap ? decisionJson.trap_price : null,
                trapSide: isTrap ? decisionJson.side : null,
                tpPrice: decisionJson.tp_price || decisionJson.trap_tp_price,
                slPrice: decisionJson.sl_price || decisionJson.trap_sl_price
            });
        }
        
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
            alertTitle = mode === "TRIPWIRE_HIT" ? `📈 Agent HARVESTING (HOLD): ${asset}` : `🛡️ Agent HOLDING: ${asset}`;
            alertColor = mode === "TRIPWIRE_HIT" ? 5763719 : 11184810; 
        } else if (isClose) {
            alertTitle = mode === "TRIPWIRE_HIT" ? `💰 Agent SECURED PROFIT: ${asset}` : `🛑 Agent CLOSED: ${asset}`; 
            alertColor = 16753920; 
        } else if (decisionJson.action === "ADJUST_TP_SL") {
            alertTitle = `🎯 TP/SL Adjusted: ${asset}`;
            alertColor = 10181046;
        } else if (decisionJson.action === "UPDATE_TRIPWIRE") {
            alertTitle = `🎯 Tripwire Updated: ${asset}`;
            alertColor = 10181046;
        }

        let alertDescription = `**Conviction Score:** ${decisionJson.conviction_score || 'N/A'}/100\n**Action:** ${decisionJson.action}`;

        if (decisionJson.action === "APPROVE" || decisionJson.action === "REVERSE") {
            const entryStr = decisionJson.price ? `\n**Est. Entry:** $${decisionJson.price}` : '';
            const tpStr = decisionJson.tp_price ? `\n**Target TP:** $${decisionJson.tp_price}` : '';
            const slStr = decisionJson.sl_price ? `\n**Target SL:** $${decisionJson.sl_price}` : '';
            alertDescription = `**Action:** ${decisionJson.action}${entryStr}${tpStr}${slStr}\n**Conviction:** ${decisionJson.conviction_score || 'N/A'}/100`;
        } else if (isTrap) {
            const trapStr = `\n**Trap Price:** $${decisionJson.trap_price}`;
            const tpStr = decisionJson.trap_tp_price ? `\n**Target TP:** $${decisionJson.trap_tp_price}` : '';
            const slStr = decisionJson.trap_sl_price ? `\n**Target SL:** $${decisionJson.trap_sl_price}` : '';
            alertDescription = `**Action:** GHOST_TRAP${trapStr}${tpStr}${slStr}\n**Conviction:** ${decisionJson.conviction_score || 'N/A'}/100`;
        }

        alertDescription += `\n\n**Working Thesis:**\n_${decisionJson.working_thesis || 'No thesis provided'}_`;

        // 🟢 THE EVOLUTION: Mute 'APPROVED' notifications (keep onlySprung/Ghost/Veto/Close/Adjustments)
        if (decisionJson.action !== "APPROVE" && decisionJson.action !== "ADJUST_TP_SL" && decisionJson.action !== "UPDATE_TRIPWIRE") {
            await sendDiscordAlert(tenant_id, {
                title: alertTitle,
                description: alertDescription,
                color: alertColor, 
                imageUrl: chartUrl
            });
        }

        const isActionableExecution = decisionJson.action === "APPROVE" || decisionJson.action === "REVERSE" || decisionJson.action === "CLOSE" || decisionJson.action === "ADJUST_TP_SL" || decisionJson.action === "UPDATE_TRIPWIRE";
        
        if (!isActionableExecution) {
            console.log(`[AGENT CORTEX] Logging non-execution action (${decisionJson.action}) to UI Audit...`);
            
            let finalStatus = decisionJson.action;
            let displayPosition = openTrade ? `${openTrade.side} @ $${openTrade.entry_price}` : "NONE";
            
            if (isTrap) {
                finalStatus = "TRAP_ACTIVE";
                displayPosition = `TRAP ${decisionJson.side} @ $${decisionJson.trap_price}`;
            }

            try {
                await supabase.from('scan_results').insert([{
                    tenant_id: tenant_id,
                    strategy: strategy_id || 'MANUAL',
                    asset: asset,
                    status: finalStatus,
                    telemetry: {
                        status_overlay: `AGENT ${decisionJson.action}`,
                        oracle_reasoning: decisionJson.working_thesis,
                        cvd: marketState?.multi_timeframe_cvd?.["5M_Micro_Ripple"] || 0,
                        open_position: displayPosition
                    }
                }]);
            } catch (error) {
                console.error(`[SUPABASE ERROR] Failed to insert scan_results for ${asset}:`, error.message);
            }
        }
        
        if (isActionableExecution || decisionJson.action === "ADJUST_TP_SL") {
            console.log(`[AGENT CORTEX] Triggering execute_order tool for action: ${decisionJson.action}`);
            
            // 🟢 REVERSE: Two-step close → wait → open opposite
            if (decisionJson.action === "REVERSE" && isReEvaluation && activeOpenTrade) {
                // STEP 1: Close existing position
                console.log(`[AGENT CORTEX] 🔄 REVERSE step 1: Closing ${activeOpenTrade.side} position...`);
                const closeResult = await fetch(mcpUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tool: 'execute_order',
                        arguments: {
                            tenant_id, symbol: asset, execution_mode, strategy_id, version,
                            side: activeOpenTrade.side === 'BUY' ? 'SELL' : 'BUY',
                            qty: activeOpenTrade.qty,
                            price: decisionJson.price,
                            reason: `[REVERSE_CLOSE] ${decisionJson.working_thesis}`
                        }
                    })
                }).then(r => r.json()).catch(e => ({ error: e.message }));

                // 🛡️ PHASE K: VERIFY STEP 1 CLOSED before opening the opposite leg.
                // executeTradeMCP returns either:
                //   { status: 'closed_position', ... }   ← good
                //   { status: 'already_closed_natively' } ← good (exchange already flat)
                //   { error: '...' }                     ← step 2 must abort
                // The MCP gateway wraps the response in { result: <executeTradeMCP return> }.
                const closePayload = closeResult?.result || closeResult || {};
                const closeOk = closePayload.status === 'closed_position' || closePayload.status === 'already_closed_natively';
                if (!closeOk) {
                    const reason = closePayload.error || closePayload.status || 'unknown';
                    console.error(`[AGENT CORTEX] 🛑 REVERSE step 1 did NOT confirm close (status=${reason}). Aborting step 2 to prevent double-position.`);
                    await sendDiscordAlert(tenant_id, {
                        title: `🛑 REVERSE Aborted: ${asset}`,
                        description: `Step 1 (close ${activeOpenTrade.side}) did not confirm. Step 2 (open ${decisionJson.side}) suppressed to prevent dual-direction exposure.\n**Engine status:** ${reason}\n**Action:** Manual review required.`,
                        color: 15158332
                    });
                    return res.status(200).json({ status: 'REVERSE_ABORTED', reason });
                }

                // STEP 2: Wait for exchange clearing
                console.log(`[AGENT CORTEX] ⏳ REVERSE pause: Waiting 2s for bracket clearing...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // STEP 3: Open new opposite position
                console.log(`[AGENT CORTEX] 🔄 REVERSE step 2: Opening ${decisionJson.side} position...`);
                await fetch(mcpUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tool: 'execute_order',
                        arguments: {
                            tenant_id, symbol: asset, execution_mode, strategy_id, version,
                            side: decisionJson.side,
                            qty: decisionJson.qty || qty || activeOpenTrade.qty || 1,
                            price: decisionJson.price,
                            tp_price: decisionJson.tp_price,
                            sl_price: decisionJson.sl_price,
                            reason: `[REVERSE_OPEN] ${decisionJson.working_thesis}`
                        }
                    })
                });
            }
            // 🟢 ADJUST_TP_SL: Cancel brackets + place new ones (handled via execute_order with reason flag)
            else if (decisionJson.action === "ADJUST_TP_SL" && openTrade) {
                const newTp = decisionJson.new_tp_price || decisionJson.tp_price;
                const newSl = decisionJson.new_sl_price || decisionJson.sl_price;
                const entryPrice = parseFloat(openTrade.entry_price);
                
                // 🛡️ ACCOUNTANT PROTOCOL: Enforce hard R/R >= 1.5 floor in the decision layer
                if (newTp && newSl && entryPrice) {
                    const tpDist = Math.abs(parseFloat(newTp) - entryPrice);
                    const slDist = Math.abs(entryPrice - parseFloat(newSl));
                    const riskReward = slDist > 0 ? (tpDist / slDist) : 0;
                    if (riskReward < 1.5) {
                        console.warn(`[ACCOUNTANT PROTOCOL] Agent ADJUST_TP_SL REJECTED for ${asset}. R/R ${riskReward.toFixed(2)} < 1.5. TP: $${newTp}, SL: $${newSl}, Entry: $${entryPrice}`);
                        await sendDiscordAlert(tenant_id, {
                            title: `🚫 Accountant Veto: ${asset}`,
                            description: `**Action:** ADJUST_TP_SL blocked\n**New R/R:** ${riskReward.toFixed(2)} (minimum 1.5)\n**Proposed TP:** $${newTp}\n**Proposed SL:** $${newSl}\n**Entry:** $${entryPrice}\n**Reason:** Agent attempted to degrade R/R below hard floor. Macro thesis cannot override immutable risk parameters.`,
                            color: 15548997
                        });
                        const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
                        const vetoEntry = `\n[${timeStr}Z] [ACCOUNTANT VETO]: ADJUST_TP_SL blocked — R/R ${riskReward.toFixed(2)} < 1.5`;
                        const rollingLedger = (openTrade.reason || '') + vetoEntry;
                        await supabase.from('trade_logs').update({ reason: rollingLedger }).eq('id', openTrade.id);
                        return res.status(200).json({ status: "RR_VETOED", message: `R/R ${riskReward.toFixed(2)} < 1.5 floor` });
                    }
                    console.log(`[ACCOUNTANT PROTOCOL] Agent ADJUST_TP_SL R/R check passed: ${riskReward.toFixed(2)} >= 1.5`);
                }
                
                // Update DB immediately
                const updateFields = {};
                if (newTp) updateFields.tp_price = parseFloat(newTp);
                if (newSl) updateFields.sl_price = parseFloat(newSl);
                if (Object.keys(updateFields).length > 0) {
                    await supabase.from('trade_logs').update(updateFields).eq('id', openTrade.id);
                }
                
                // For LIVE mode: call execute_order with ADJUST_TP_SL reason to trigger bracket swap
                if (execution_mode === 'LIVE' && (newTp || newSl)) {
                    await fetch(mcpUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            tool: 'execute_order',
                            arguments: {
                                tenant_id, symbol: asset,
                                side: openTrade.side,
                                trade_id: openTrade.id,
                                tp_price: newTp ? parseFloat(newTp) : undefined,
                                sl_price: newSl ? parseFloat(newSl) : undefined,
                                qty: openTrade.qty,
                                execution_mode: 'LIVE',
                                reason: '[ADJUST_TP_SL] Agent adjusted bracket targets'
                            }
                        })
                    });
                }
                
                // Update reasoning ledger
                const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const logEntry = `\n[${timeStr}Z] [ADJUST_TP_SL]: TP: ${newTp || 'unchanged'} | SL: ${newSl || 'unchanged'} — ${decisionJson.working_thesis}`;
                const rollingLedger = (openTrade.reason || '') + logEntry;
                await supabase.from('trade_logs').update({ reason: rollingLedger }).eq('id', openTrade.id);
                
                // Discord notification
                await sendDiscordAlert(tenant_id, {
                    title: `🎯 TP/SL Adjusted: ${asset}`,
                    description: `**Action:** ADJUST_TP_SL\n**New TP:** ${newTp ? '$' + newTp : 'Unchanged'}\n**New SL:** ${newSl ? '$' + newSl : 'Unchanged'}\n**Thesis:** ${decisionJson.working_thesis}`,
                    color: 10181046
                });
            }
            // 🟢 UPDATE_TRIPWIRE: Direct DB write to strategy_config.parameters JSONB
            else if (decisionJson.action === "UPDATE_TRIPWIRE" && activeOpenTrade) {
                let newTripwirePct = decisionJson.tripwire_percent;
                let newTrailStepPct = decisionJson.trail_step_percent;
                
                newTripwirePct = normalizePercent(newTripwirePct, 'Tripwire');
                newTrailStepPct = normalizePercent(newTrailStepPct, 'Trail step');
                
                if (newTripwirePct !== undefined || newTrailStepPct !== undefined) {
                    const { data: strategyConfigs } = await supabase
                        .from('strategy_config')
                        .select('id, parameters')
                        .eq('tenant_id', tenant_id)
                        .eq('asset', asset)
                        .eq('strategy', strategy_id || 'MANUAL')
                        .limit(1)
                        .maybeSingle();
                    
                    if (strategyConfigs) {
                        const currentParams = strategyConfigs.parameters || {};
                        const updatedParams = { ...currentParams };
                        
                        if (newTripwirePct !== undefined) {
                            updatedParams.tripwire_percent = parseFloat(newTripwirePct);
                            console.log(`[AGENT CORTEX] 🔄 Tripwire updated: ${asset} → ${updatedParams.tripwire_percent}`);
                        }
                        if (newTrailStepPct !== undefined) {
                            updatedParams.trail_step_percent = parseFloat(newTrailStepPct);
                            console.log(`[AGENT CORTEX] 🔄 Trail step updated: ${asset} → ${updatedParams.trail_step_percent}`);
                        }
                        
                        await supabase.from('strategy_config')
                            .update({ parameters: updatedParams })
                            .eq('id', strategyConfigs.id)
                            .eq('tenant_id', tenant_id);
                    }
                }
                
                // Update reasoning ledger
                const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const logEntry = `\n[${timeStr}Z] [UPDATE_TRIPWIRE]: Tripwire: ${newTripwirePct ?? 'unchanged'} | Trail Step: ${newTrailStepPct ?? 'unchanged'} — ${decisionJson.working_thesis}`;
                const rollingLedger = (activeOpenTrade.reason || '') + logEntry;
                await supabase.from('trade_logs').update({ reason: rollingLedger }).eq('id', activeOpenTrade.id);
                
                await sendDiscordAlert(tenant_id, {
                    title: `🎯 Tripwire Updated: ${asset}`,
                    description: `**Tripwire %:** ${newTripwirePct !== undefined ? (parseFloat(newTripwirePct) * 100).toFixed(2) + '%' : 'Unchanged'}\n**Trail Step %:** ${newTrailStepPct !== undefined ? (parseFloat(newTrailStepPct) * 100).toFixed(2) + '%' : 'Unchanged'}\n**Thesis:** ${decisionJson.working_thesis}`,
                    color: 10181046
                });
            }
            // 🟢 SELF-ADJUSTMENT: UPDATE_PARAMS — Permanently update strategy
            // parameters when the AI detects a persistent loss pattern. This
            // closes the self-improvement loop: detect → adjust → improve.
            else if (decisionJson.action === "UPDATE_PARAMS") {
                const targetStrategy = decisionJson.strategy || strategy_id || 'MANUAL';
                const targetAsset = decisionJson.asset || asset;
                const newParams = decisionJson.params || {};

                if (Object.keys(newParams).length === 0) {
                    console.warn(`[SELF-ADJUST] UPDATE_PARAMS aborted — no params provided for ${targetAsset}/${targetStrategy}`);
                    return res.status(200).json({ status: "UPDATE_PARAMS_FAILED", reason: "No params provided" });
                }

                const { data: config } = await supabase
                    .from('strategy_config')
                    .select('id, parameters')
                    .eq('tenant_id', tenant_id)
                    .eq('asset', targetAsset)
                    .eq('strategy', targetStrategy)
                    .single();

                if (!config) {
                    console.warn(`[SELF-ADJUST] Strategy config not found for ${targetAsset}/${targetStrategy}`);
                    return res.status(200).json({ status: "UPDATE_PARAMS_FAILED", reason: "Strategy config not found" });
                }

                const mergedParams = { ...(config.parameters || {}), ...newParams };
                await supabase.from('strategy_config').update({
                    parameters: mergedParams,
                    updated_at: new Date().toISOString()
                }).eq('id', config.id).eq('tenant_id', tenant_id);

                console.log(`[SELF-ADJUST] Updated params for ${targetAsset}/${targetStrategy}: ${JSON.stringify(newParams)}`);

                await sendDiscordAlert(tenant_id, {
                    title: `🔄 Self-Adjustment: ${targetAsset}`,
                    description: `**Strategy:** ${targetStrategy}\\n**Reason:** ${decisionJson.reasoning || 'Self-adjustment triggered'}\\n**Params:** ${JSON.stringify(newParams, null, 2)}\\n**Conviction:** ${decisionJson.conviction_score || 'N/A'}/100`,
                    color: 15844367
                });

                return res.status(200).json({ status: "UPDATE_PARAMS_SUCCESS", params: mergedParams });
            }
            // 🟢 CLOSE or APPROVE (existing behavior)
            else if (!executeOrderCalledInLoop) {
                decisionJson.tenant_id = tenant_id;
                decisionJson.symbol = asset;
                decisionJson.execution_mode = execution_mode || 'PAPER';
                decisionJson.strategy_id = strategy_id || 'MANUAL';
                decisionJson.version = version || 'v1.0';
                decisionJson.working_thesis = decisionJson.working_thesis || 'Autonomous Execution';
                decisionJson.qty = qty || decisionJson.qty || 1;

                // 🟢 Attach the full market state snapshot + influencing memory IDs
                // so the trade record has the rich market data at entry and knows
                // which core memories influenced the AI's decision.
                if (marketState?.result) {
                    decisionJson._full_market_snapshot = marketState.result;
                }
                if (memoryIds && memoryIds.length > 0) {
                    decisionJson._influencing_memory_ids = memoryIds;
                }
                
                if (decisionJson.action === "CLOSE" && activeOpenTrade) {
                    decisionJson.side = activeOpenTrade.side === 'BUY' ? 'SELL' : 'BUY';
                    decisionJson.qty = activeOpenTrade.qty;
                    decisionJson.reason = `[CLOSE] ${decisionJson.working_thesis}`;
                } else if (decisionJson.action === "CLOSE" && openTrade) {
                    decisionJson.side = openTrade.side === 'BUY' ? 'SELL' : 'BUY';
                    decisionJson.qty = openTrade.qty;
                    decisionJson.reason = `[CLOSE] ${decisionJson.working_thesis}`;
                } else {
                    decisionJson.reason = decisionJson.working_thesis;
                }
                
                await fetch(mcpUrl, {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tool: 'execute_order', arguments: decisionJson })
                });
            }
        }

    } catch (error) {
        console.error(`[AGENT FATAL]:`, error.message);
    }
});

// 🟢 THE EVOLUTION ENDPOINT (Agentic Reflection Loop)
app.post('/api/autopsy', async (req, res) => {
    const { tenant_id, asset, entry_price, exit_price, pnl, rolling_ledger, trigger, macro_tf, trigger_tf, execution_mode, regime_at_close, market_snapshot, working_thesis, trade_log_id } = req.body;
    console.log(`[AGENT CORTEX] Initiating Autopsy for ${asset}. PnL: $${pnl} (${execution_mode || 'UNKNOWN'})`);
    
    res.status(200).json({ status: "Autopsy initiated." });

    try {
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) throw new Error("Missing Gemini API Key.");

        // 🟢 ENHANCED AUTOPSY: Fetch market context for better lesson extraction.
        // Prefer the trimmed snapshot captured at the exact moment of close (passed
        // from executeTradeMCP), and additionally enrich with a fresh market-state
        // pull. We now PERSIST whichever snapshot we end up with into core memory.
        let marketContext = '';
        let persistedSnapshot = market_snapshot || null;
        if (market_snapshot) {
            marketContext += `\n\n--- MARKET CONDITIONS AT CLOSE ---\n${JSON.stringify(market_snapshot, null, 2).substring(0, 1200)}`;
        }
        try {
            const mcpUrl = process.env.MCP_GATEWAY_URL;
            if (mcpUrl) {
                const stateResp = await fetch(mcpUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tool: 'get_market_state', arguments: { symbol: asset, macro_tf: macro_tf || 'ONE_HOUR', trigger_tf: trigger_tf || 'FIVE_MINUTE', tenant_id } })
                }).catch(() => ({ json: () => ({}) }));
                const stateData = await stateResp.json();
                if (stateData?.result) {
                    marketContext += `\n\n--- MARKET CONTEXT AT AUTOPSY ---\n${JSON.stringify(stateData.result, null, 2).substring(0, 2000)}`;
                    persistedSnapshot = stateData.result; // Always prefer fresh market state
                }
            }
        } catch (e) {
            console.warn("[AUTOPSY] Market data fetch failed:", e.message);
        }

        const winLoss = parseFloat(pnl) >= 0 ? "WIN" : "LOSS";

        const autopsyPrompt = `
        You are the Hermes Quantitative Reflection Engine.
        A trade just closed for ${asset}.
        Entry: $${entry_price} | Exit: $${exit_price} | PnL: $${pnl} (${winLoss})
        Exit Trigger: ${trigger}

        WORKING THESIS AT ENTRY:
        ${working_thesis || "No thesis recorded."}

        ROLLING LEDGER (Your thoughts during the trade):
        ${rolling_ledger || "No ledger recorded."}

        ${marketContext}

        Analyze this trade. What validator tools were mentioned in the ledger?
        Why did it win or lose?
        Evaluate the original working thesis — was the thesis correct even if
        the trade lost, or flawed even if it won?
        Extract ONE concise, quantitative behavioral rule to improve future
        performance for this specific asset. Do not give generic advice. Give
        hard mathematical/structural rules based on the ledger context.

        Output raw JSON format exactly:
        {
          "tools_used": "Comma separated list of tools mentioned (e.g., Fibonacci, Fractals, Volume Nodes, Open Interest)",
          "lesson_learned": "The specific quantitative rule extracted.",
          "thesis_accurate": true or false,
          "thesis_summary": "One-line summary of what the thesis was trying to capture"
        }
        `;

        const activeModel = await getActiveModel(supabase);
        let llmUrl, llmHeaders, llmBody;

        if (activeModel.provider === 'openrouter') {
            const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
            llmUrl = `${baseUrl}/chat/completions`;
            llmHeaders = {
                'Authorization': `Bearer ${activeModel.apiKey}`,
                'Content-Type': 'application/json'
            };
            llmBody = {
                model: activeModel.model,
                messages: [
                    { role: 'system', content: "You are an AI post-mortem trading analyzer. Output ONLY raw, valid JSON." },
                    { role: 'user', content: autopsyPrompt }
                ],
                response_format: { type: 'json_object' }
            };
        } else {
            llmUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel.model}:generateContent?key=${activeModel.apiKey || geminiKey}`;
            llmHeaders = { 'Content-Type': 'application/json' };
            llmBody = {
                systemInstruction: { parts: [{ text: "You are an AI post-mortem trading analyzer. Output ONLY raw, valid JSON." }] },
                contents: [{ role: "user", parts: [{ text: autopsyPrompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            };
        }

        const llmResp = await fetch(llmUrl, { method: 'POST', headers: llmHeaders, body: JSON.stringify(llmBody) });
        if (!llmResp.ok) throw new Error(`AI API Error (${activeModel.provider}): ${await llmResp.text()}`);

        const llmData = await llmResp.json();
        let rawText = activeModel.provider === 'openrouter'
            ? llmData.choices[0]?.message?.content
            : llmData.candidates[0]?.content?.parts[0]?.text;

        if (!rawText) {
            throw new Error(`Empty autopsy response returned from ${activeModel.provider}`);
        }
        
        // 🟢 THE FIX: Aggressive JSON Extractor for Autopsy
        const firstBrace = rawText.indexOf('{');
        const lastBrace = rawText.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1) {
            rawText = rawText.substring(firstBrace, lastBrace + 1);
        } else {
            throw new Error("No valid JSON object found in autopsy response.");
        }
        
        const autopsyJson = JSON.parse(rawText);

        console.log(`[AUTOPSY COMPLETE] ${asset} | Rule: ${autopsyJson.lesson_learned}`);

        await supabase.from('hermes_core_memory').insert([{
            tenant_id: tenant_id,
            asset: asset,
            win_loss: winLoss,
            tools_used: autopsyJson.tools_used || "None",
            lesson_learned: autopsyJson.lesson_learned,
            working_thesis: working_thesis || null,
            thesis_accurate: autopsyJson.thesis_accurate ?? null,
            thesis_summary: autopsyJson.thesis_summary || null,
            // Enriched dissection fields (paper + live) — what the trade actually
            // did and what the market looked like when it closed.
            entry_price: entry_price ?? null,
            exit_price: exit_price ?? null,
            pnl: pnl ?? null,
            execution_mode: execution_mode || null,
            regime_at_close: regime_at_close || null,
            market_snapshot: persistedSnapshot || null,
            trade_log_id: trade_log_id || null
        }]);

    } catch (error) {
        console.error(`[AUTOPSY FATAL]:`, error.message);
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AGENT CORTEX] Online. Listening for Sniper flares on port ${PORT}`);
});

// 🟢 Boot the Discord text bridge (dynamic import — only needed at runtime on VPS)
(async () => {
  try {
    const { default: bridge } = await import('./lib/discord-bridge.js');
    const active = await bridge.start();
    console.log(`[AGENT CORTEX] Discord bridge ${active ? '✅ active' : '❌ disabled (check env vars)'}`);
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message?.includes('discord.js')) {
      console.warn('[AGENT CORTEX] Discord bridge not available (discord.js not installed in this environment)');
    } else {
      console.error('[AGENT CORTEX] Discord bridge failed to boot:', e.message);
    }
  }
})();