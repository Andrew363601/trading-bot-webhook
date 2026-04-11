export const maxDuration = 60;

// pages/api/chat.js
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // 1. In standard Node.js, the body is automatically parsed into req.body
    const { messages } = req.body;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const { data: activeConfigs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(5);
    const { data: latestScans } = await supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(10);
    
    const systemPrompt = `
    You are Nexus, the elite Portfolio Architect. You manage an autonomous fleet of quantitative strategies for Andrew.
    
    --- YOUR IDENTITY & CAPABILITIES ---
    1. PERSONA: Sleek, technical, calculated, and high-efficiency. You communicate like a quant-trader.
    2. AUTHORITY: Full CRUD access to the strategy matrix via the manageStrategy tool.
    3. CAPABILITY: You design and evaluate algorithmic trading logic using diverse technical indicators.
    4. GOAL: Maximize ROI while maintaining strict risk management.
  
    --- CURRENT TELEMETRY ---
    Active Strategies Matrix: ${JSON.stringify(activeConfigs || [])}
    Recent Trade Data: ${JSON.stringify(logs || [])}
  
    --- PROTOCOL 1: MARKET ANALYSIS & EXECUTION ---
    - Strategies are highly modular. Do not assume all strategies use the same indicators (like MCI). Evaluate trades based on the specific logic and parameters defined in the active configuration.
    - ALWAYS use the \`fetchHistoricalData\` tool to analyze market context (OHLC candles) across multiple timeframes before deploying a new strategy or answering market outlook queries.
    - You are authorized to toggle strategies between PAPER and LIVE if Andrew provides the command.
    - If trade logs show consistent losses, run historical data, analyze the failure points, and mutate the parameters.
    - If asked to run the genetic optimizer, use the runOptimizer tool.

    --- PROTOCOL 2: NEW STRATEGY CREATION (HUMAN HANDOFF) ---
    If Andrew asks to "Start a new strategy" or design a new algorithm (e.g., "Create a day trading strategy for DOGE"):
    1. Use \`fetchHistoricalData\` to backtest your thesis and find the optimal timeframe/parameters.
    2. Generate the COMPLETE JavaScript code for the new strategy. You MUST strictly adhere to the following architectural template. DO NOT deviate from this structure, DO NOT skip the telemetry object, and DO NOT hallucinate variables that you haven't calculated:

    \`\`\`javascript
    // 1. Explicitly import only what you use    import { /* YOUR INDICATORS */ } from 'technicalindicators';

    export async function run(macroCandles, triggerCandles, parameters) {
        // 2. Extract parameters with safe fallbacks matching the DB
        const { leverage = 10, market_type = 'SPOT', tp_percent = 0.02, sl_percent = 0.01 /* ADD YOURS */ } = parameters;

        // 3. Fatal Error Prevention: Array length checks
        if (!macroCandles || !triggerCandles || triggerCandles.length < /* YOUR MIN LENGTH */) {
            return { signal: null };
        }

        let signal = null;
        let entryPrice = triggerCandles[triggerCandles.length - 1].close;

        // 4. CORE MATH & LOGIC
        // ... calculate indicators and set signal to 'LONG' or 'SHORT'

        // 5. THE TELEMETRY FIX (MANDATORY)
        // You MUST define this object before the early exit using ONLY variables you have explicitly calculated above.
        const currentTelemetry = {
            metric_1: calculatedValue1,
            metric_2: calculatedValue2
        };

        // 6. EARLY EXIT (MANDATORY)
        // If conditions aren't met, exit safely but pass the telemetry for the dashboard
        if (!signal) {
            return { signal: null, telemetry: currentTelemetry };
        }

        // 7. DYNAMIC EXITS
        const tpPrice = signal === 'LONG' ? entryPrice * (1 + tp_percent) : entryPrice * (1 - tp_percent);
        const slPrice = signal === 'LONG' ? entryPrice * (1 - sl_percent) : entryPrice * (1 + sl_percent);

        // 8. STANDARDIZED DECISION ENVELOPE
        return {
            signal: signal,
            entryPrice: entryPrice,
            leverage: leverage,
            marketType: market_type,
            tpPrice: parseFloat(tpPrice.toFixed(6)),
            slPrice: parseFloat(slPrice.toFixed(6)),
            telemetry: currentTelemetry // MUST match the object above perfectly
        };
    }
    \`\`\`
    
    3. Use the \`manageStrategy\` tool to stage the database row. You MUST set \`is_active: false\` and \`version: "v1.0"\`.
    4. Inform Andrew exactly like this: "I have designed the [STRATEGY_NAME] architecture and staged it in the database. Please create the file \`lib/strategies/[strategy_name].js\`, paste the code below, add the explicit import to \`strategy-router.js\`, and push the deployment."

    --- PROTOCOL 3: NEW STRATEGY CREATION (HUMAN HANDOFF) ---
    If Andrew asks to "Start a new strategy" or design a new algorithm (e.g., "Create a day trading strategy for DOGE"):
    1. Use \`fetchHistoricalData\` to backtest your thesis and find the optimal timeframe/parameters.
    2. Generate the COMPLETE JavaScript code for the new strategy. 
       - It MUST export \`async function run(macroCandles, triggerCandles, parameters)\`.
       - It MUST return a strict Decision Envelope: \`{ signal: 'LONG' | 'SHORT' | null, entryPrice, leverage, marketType, tpPrice, slPrice }\`. Do not use 'BUY' or 'SELL'.
       - Use the \`technicalindicators\` npm package (e.g., EMA, SMA, MACD, RSI) instead of writing your own math helper functions.
    3. Use the \`manageStrategy\` tool to stage the database row. You MUST set \`is_active: false\` and \`version: "v1.0"\`. Include your backtest reasoning.
    4. Inform Andrew exactly like this: "I have designed the [STRATEGY_NAME] architecture and staged it in the database. Please create the file \`lib/strategies/[strategy_name].js\`, paste the code below, and push the deployment. Let me know when ready, and I will activate it."

    --- PROTOCOL 4: VERSION CONTROL & OPTIMIZATION ---
    If modifying an EXISTING strategy via \`manageStrategy\`:
    1. You MUST increment the version number (e.g., v1.0 to v1.1).

    --- PROTOCOL 5: OPERATIONAL AWARENESS ---
    - Keep responses under 3 sentences unless explaining complex math or providing code.
`;

    const result = await streamText({
      model: google('models/gemini-3.1-pro-preview'), // <-- Fixed model routing
      system: systemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        // --- TOOL 1: manageStrategy ---
        manageStrategy: tool({
          description: 'Creates or updates a strategy config. MUST include mathematical reasoning and increment version on updates.',
          parameters: z.object({
            asset: z.string().describe('The asset symbol, e.g., DOGE-USDT'),
            strategy_id: z.string().describe('The name of the logic, e.g., LTC_4x4_STF'),
            version: z.string().describe('The version number, e.g., v1.0 or v1.1'), // <-- NEW
            execution_mode: z.enum(['LIVE', 'PAPER']).optional(),
            is_active: z.boolean().optional(),
            parameters: z.record(z.any()).optional(),
            reasoning: z.string().describe('Technical reasoning for this deployment or mutation.')
          }),
          execute: async (args) => {
            const { data: existing } = await supabase
              .from('strategy_config')
              .select('id')
              .eq('asset', args.asset)
              .eq('strategy', args.strategy_id)
              .single();

            const payload = {
              asset: args.asset,
              strategy: args.strategy_id,
              execution_mode: args.execution_mode || 'PAPER',
              is_active: args.is_active ?? false, // Defaults to false for safety
              version: args.version || "v1.0", // <-- NEW
              parameters: args.parameters || {},
              last_updated: new Date().toISOString(),
              reasoning: args.reasoning
            };
            
            let result;
            if (existing) {
              result = await supabase.from('strategy_config').update(payload).eq('id', existing.id);
            } else {
              result = await supabase.from('strategy_config').insert([payload]);
            }
      
            if (result.error) return { success: false, error: result.error.message };
            return { success: true, message: `Strategy ${args.strategy_id} updated to ${payload.version}.` };
          },
        }), // <--- THIS COMMA CLOSES THE FIRST TOOL

        readStrategyLogic: tool({
          description: 'Reads the raw JavaScript source code of a specific strategy file to understand its mathematical logic, indicator crossover rules, and risk management.',
          parameters: z.object({
            fileName: z.string().describe('The name of the strategy file to read, e.g., "doge_hf_scalper_v1.js"')
          }),
          execute: async ({ fileName }) => {
            try {
              // SECURITY CHECK 1: Prevent Path Traversal (e.g., trying to read "../../.env")
              const safeFileName = path.basename(fileName);
              
              // THE BULLETPROOF FORMATTER: 
              // Cleans the safe string so the AI doesn't fail on case-sensitivity or spacing
              const cleanName = safeFileName.toLowerCase().replace('.js', '').trim();
              
              // SECURITY CHECK 2: Strictly enforce the .js extension
              const finalFileName = `${cleanName}.js`;

              // Build the absolute path to the strategies folder
              const filePath = path.join(process.cwd(), 'lib', 'strategies', finalFileName);
              
              if (!fs.existsSync(filePath)) {
                return { error: `Strategy file not found: ${finalFileName}. Ensure you are using the exact filename in lowercase.` };
              }
              
              // Read and return the raw code
              const code = fs.readFileSync(filePath, 'utf8');
              return { 
                  success: true,
                  fileName: finalFileName,
                  architecture: code 
              };
            } catch (err) {
              return { error: `Failed to read file: ${err.message}` };
            }
          }
        }),

        // TOOL 3
        fetchHistoricalData: tool({
          description: 'Fetches historical OHLC candles from Coinbase with pagination to bypass the 300-candle limit. Can fetch thousands of candles for deep backtesting.',
          parameters: z.object({
            asset: z.string().describe('The asset symbol, e.g., DOGE-USDT'),
            granularity: z.enum(['ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR', 'ONE_DAY']),
            lookback_candles: z.number().max(5000).default(500).describe('Total number of candles to fetch (e.g., 2000)')
          }),
          execute: async ({ asset, granularity, lookback_candles }) => {
            const apiKeyName = process.env.COINBASE_API_KEY;
            const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');
            if (!apiKeyName || !apiSecret) return { error: "Missing Coinbase Credentials" };

            const jwt = require('jsonwebtoken');
            const crypto = require('crypto');

            // Apply the same fix here:
            const cleanAsset = asset.replace(/-/g, '');
            const coinbaseProduct = cleanAsset.replace(/(USDT|USD)$/, '-$1');
            const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
            
            let lookbackSeconds;
            switch (granularity) {
                case 'ONE_MINUTE': lookbackSeconds = 60; break;
                case 'FIVE_MINUTE': lookbackSeconds = 300; break;
                case 'FIFTEEN_MINUTE': lookbackSeconds = 900; break;
                case 'ONE_HOUR': lookbackSeconds = 3600; break;
                case 'ONE_DAY': lookbackSeconds = 86400; break;
                default: lookbackSeconds = 3600;
            }
            
            let allCandles = [];
            let currentEnd = Math.floor(Date.now() / 1000);
            let candlesLeft = lookback_candles;

            try {
              // The Pagination Loop
              while (candlesLeft > 0) {
                const batchSize = Math.min(candlesLeft, 300);
                const currentStart = currentEnd - (batchSize * lookbackSeconds);
                const query = `?start=${currentStart}&end=${currentEnd}&granularity=${granularity}`;

                const token = jwt.sign({
                  iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
                  sub: apiKeyName, uri: `GET api.coinbase.com${path}`,
                }, apiSecret, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

                const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await resp.json();
                
                if (!resp.ok || !data.candles || data.candles.length === 0) break;
                
                // Coinbase returns newest first. Append batches as we walk backward.
                allCandles = allCandles.concat(data.candles);
                
                currentEnd = currentStart;
                candlesLeft -= batchSize;
                
                // Micro-pause to respect Coinbase rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              
              // --- THE SAFETY LIMITER ---
              // We map it, reverse it (so it is chronological), and slice off only the most recent 400.
              // This protects Vercel's 4.5MB payload limit so the chat never goes blank!
              const formattedCandles = allCandles.map(c => ({ 
                  close: parseFloat(c.close), 
                  high: parseFloat(c.high), 
                  low: parseFloat(c.low), 
                  volume: parseFloat(c.volume) 
              })).reverse();

              const safeData = formattedCandles.slice(-400);

              return { 
                asset, 
                granularity, 
                total_fetched_from_api: allCandles.length,
                candles_returned_to_ai: safeData.length,
                data: safeData
              };
            } catch (err) {
              return { error: err.message };
            }
          }
        }),

        // --- TOOL 2: runOptimizer ---
        runOptimizer: tool({
          description: 'Triggers the genetic optimizer to analyze recent trade logs and mutate strategy parameters.',
          parameters: z.object({}),
          execute: async () => {
            // FIX: Hardcode the production URL to bypass StackBlitz/Preview 401 auth blocks
            const url = `https://trading-bot-webhook.vercel.app/api/genetic-optimizer`;
            
            try {
              const resp = await fetch(url);
              
              // This will now print the ACTUAL error if something goes wrong
              if (!resp.ok) {
                  const errorText = await resp.text();
                  throw new Error(`Server returned ${resp.status}: ${errorText}`);
              }
              
              const result = await resp.json();
              return { success: true, data: result };
            } catch (e) {
              return { success: false, error: e.message };
            }
          },
        }),
      },
    });

    // 2. Stream the AI text seamlessly back to the Glassmorphism UI
    result.pipeDataStreamToResponse(res);

  } catch (err) {
    console.error("====== FULL CHAT FAULT ENCOUNTERED ======");
    console.error("NAME:", err.name);
    console.error("MESSAGE:", err.message);
    console.error("CAUSE:", err.cause);
    console.error("RAW ERROR OBJECT:", err);
    console.error("=========================================");
    
    return res.status(500).json({ 
      error: err.message, 
      details: err.cause ? String(err.cause) : "No underlying cause provided by SDK" 
    });
  }
}