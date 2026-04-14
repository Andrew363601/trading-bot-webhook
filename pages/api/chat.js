export const maxDuration = 300;

// pages/api/chat.js
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // 1. Ditch the manual message cleaning. 
    // The @ai-sdk handles tool/assistant/user roles perfectly natively now.
    const { messages } = req.body;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const { data: allConfigs } = await supabase.from('strategy_config').select('*');
    const { data: openTrades } = await supabase.from('trade_logs').select('*').is('exit_price', null);
    const { data: recentClosedLogs } = await supabase.from('trade_logs').select('*').not('exit_price', 'is', null).order('id', { ascending: false }).limit(5);
    
    let livePrices = {};
    if (openTrades && openTrades.length > 0) {
      const uniqueAssets = [...new Set(openTrades.map(t => t.symbol))];
      for (const asset of uniqueAssets) {
        try {
          const baseCoin = asset.split('-')[0]; 
          const priceResp = await fetch(`https://api.exchange.coinbase.com/products/${baseCoin}-USD/ticker`);
          if (priceResp.ok) {
            const priceData = await priceResp.json();
            livePrices[asset] = parseFloat(priceData.price || 0);
          }
        } catch (err) {
          console.warn(`[NEXUS RADAR WARN] Could not fetch live price for ${asset}`);
        }
      }
    }
    
    const systemPrompt = `
    You are Nexus, the elite Portfolio Architect. You manage an autonomous fleet of quantitative strategies for Andrew.
    
    --- YOUR IDENTITY & CAPABILITIES ---
    1. PERSONA: Sleek, technical, calculated, and high-efficiency. You communicate like a quant-trader.
    2. AUTHORITY: Full CRUD access to the strategy matrix via the manageStrategy tool.
    3. CAPABILITY: You design and evaluate algorithmic trading logic using diverse technical indicators.
    4. GOAL: Maximize ROI using Perpetual Futures leverage while maintaining strict risk management.
  
    --- CURRENT TELEMETRY ---
    Strategy Matrix (All Active & Paused): ${JSON.stringify(allConfigs || [])}
    Current Open Trades: ${JSON.stringify(openTrades || [])}
    Live Market Prices for Open Trades: ${JSON.stringify(livePrices)}
    Recently Closed Trades (Last 5): ${JSON.stringify(recentClosedLogs || [])}
  
    --- PROTOCOL 1: MARKET ANALYSIS & EXECUTION ---
    - Andrew exclusively trades Perpetual Futures for leverage. The standard format for assets on this exchange is [COIN]-PERP-INTX (e.g., BTC-PERP-INTX, DOGE-PERP-INTX).
    - If asked for the PnL of active trades, use the 'Live Market Prices' and 'Current Open Trades' data to mathematically calculate and report the Unrealized PnL.
    - If asked for historical PnL, win rates, or performance over a specific timeframe (e.g., "this week", "to date", "on DOGE"), ALWAYS use the \`queryTradeLedger\` tool to fetch the exact data. Format the results as a Markdown table.
    - ALWAYS use the \`fetchHistoricalData\` tool with the -PERP-INTX symbol to analyze market context before deploying a new strategy or answering queries.
    - If asked to run the genetic optimizer, use the runOptimizer tool.

    --- PROTOCOL 2: NEW STRATEGY CREATION (HUMAN HANDOFF) ---
    If Andrew asks to "Start a new strategy" or design a new algorithm:
    1. Use \`fetchHistoricalData\` to backtest your thesis and find the optimal timeframe/parameters.
    2. Generate the COMPLETE JavaScript code for the new strategy. You MUST strictly adhere to the following architectural template:

    \`\`\`javascript
    import { /* YOUR INDICATORS */ } from 'technicalindicators';

    export async function run(macroCandles, triggerCandles, parameters) {
        const { leverage = 10, market_type = 'FUTURES', tp_percent = 0.02, sl_percent = 0.01 } = parameters;
        if (!macroCandles || !triggerCandles || triggerCandles.length < 50) return { signal: null };

        let signal = null;
        let entryPrice = triggerCandles[triggerCandles.length - 1].close;

        // ... logic ...

        const currentTelemetry = { metric_1: calculatedValue1 };
        if (!signal) return { signal: null, telemetry: currentTelemetry };

        const tpPrice = signal === 'LONG' ? entryPrice * (1 + tp_percent) : entryPrice * (1 - tp_percent);
        const slPrice = signal === 'LONG' ? entryPrice * (1 - sl_percent) : entryPrice * (1 + sl_percent);

        return {
            signal: signal,
            entryPrice: entryPrice,
            leverage: leverage,
            marketType: market_type,
            tpPrice: parseFloat(tpPrice.toFixed(6)),
            slPrice: parseFloat(slPrice.toFixed(6)),
            telemetry: currentTelemetry 
        };
    }
    \`\`\`
    
    3. Use the \`manageStrategy\` tool to stage the database row. You MUST set \`is_active: false\` and \`version: "v1.0"\`.
    4. Inform Andrew exactly like this: "I have designed the [STRATEGY_NAME] architecture and staged it in the database. Please create the file \`lib/strategies/[strategy_name].js\`, paste the code below, add the explicit import to \`strategy-router.js\`, and push the deployment."

    --- PROTOCOL 3: VERSION CONTROL & OPTIMIZATION ---
    If modifying an EXISTING strategy via \`manageStrategy\`:
    1. You MUST increment the version number (e.g., v1.0 to v1.1).

    --- PROTOCOL 4: OPERATIONAL AWARENESS ---
    - Keep responses under 3 sentences unless explaining complex math, providing tables, or providing code.
`;

// 2. Pass the RAW messages directly to the SDK
const result = await streamText({
  model: google('gemini-2.5-pro'), // THE FIX: Removed "models/" prefix and upgraded to Pro!
  system: systemPrompt,
  messages: messages, 
  maxSteps: 5,
      tools: {
        queryTradeLedger: tool({
          description: 'Queries the complete historical trade ledger to calculate PnL, Win Rate, and filter by asset, strategy, or timeframe.',
          parameters: z.object({
            asset: z.string().optional().describe('Filter by asset symbol, e.g., DOGE-PERP-INTX. Leave undefined for all assets.'),
            strategy_id: z.string().optional().describe('Filter by strategy, e.g., KELTNER_EXECUTION_V1. Leave undefined for all strategies.'),
            days_back: z.number().optional().describe('Number of days back to search (e.g., 7 for this week). Leave undefined for all-time.')
          }),
          execute: async ({ asset, strategy_id, days_back }) => {
            let query = supabase.from('trade_logs').select('*').not('exit_price', 'is', null);

            if (asset) query = query.eq('symbol', asset);
            if (strategy_id) query = query.eq('strategy_id', strategy_id);
            if (days_back) {
              const dateLimit = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
              query = query.gte('exit_time', dateLimit);
            }

            const { data: trades, error } = await query;
            if (error) return { error: error.message };

            const totalTrades = trades.length;
            const totalPnL = trades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
            const winningTrades = trades.filter(t => parseFloat(t.pnl) > 0).length;
            const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) + '%' : '0%';

            const breakdown = trades.reduce((acc, t) => {
              const key = `${t.strategy_id} | ${t.symbol}`;
              if (!acc[key]) acc[key] = { pnl: 0, trades: 0 };
              acc[key].pnl += (parseFloat(t.pnl) || 0);
              acc[key].trades += 1;
              return acc;
            }, {});

            return {
              timeframe: days_back ? `Last ${days_back} days` : 'All-Time',
              filters: { asset: asset || 'ALL', strategy: strategy_id || 'ALL' },
              summary: {
                total_trades: totalTrades,
                total_pnl: parseFloat(totalPnL.toFixed(4)),
                win_rate: winRate
              },
              breakdown: Object.entries(breakdown).map(([key, data]) => ({
                segment: key,
                pnl: parseFloat(data.pnl.toFixed(4)),
                trade_count: data.trades
              }))
            };
          }
        }),

        manageStrategy: tool({
          description: 'Creates or updates a strategy config.',
          parameters: z.object({
            asset: z.string().describe('The asset symbol, e.g., DOGE-PERP-INTX'),
            strategy_id: z.string().describe('The name of the logic, e.g., LTC_4x4_STF'),
            version: z.string().describe('The version number, e.g., v1.0 or v1.1'), 
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
              is_active: args.is_active ?? false, 
              version: args.version || "v1.0", 
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
        }), 

        readStrategyLogic: tool({
          description: 'Reads the raw JavaScript source code of a specific strategy file.',
          parameters: z.object({
            fileName: z.string().describe('The name of the strategy file to read, e.g., "doge_hf_scalper_v1.js"')
          }),
          execute: async ({ fileName }) => {
            try {
              const safeFileName = path.basename(fileName);
              const cleanName = safeFileName.toLowerCase().replace('.js', '').trim();
              const finalFileName = `${cleanName}.js`;
              const filePath = path.join(process.cwd(), 'lib', 'strategies', finalFileName);
              
              if (!fs.existsSync(filePath)) {
                return { error: `Strategy file not found: ${finalFileName}. Ensure you are using the exact filename in lowercase.` };
              }
              
              const code = fs.readFileSync(filePath, 'utf8');
              return { success: true, fileName: finalFileName, architecture: code };
            } catch (err) {
              return { error: `Failed to read file: ${err.message}` };
            }
          }
        }),

        fetchHistoricalData: tool({
          description: 'Fetches historical OHLC candles from Coinbase.',
          parameters: z.object({
            asset: z.string().describe('The asset symbol, e.g., DOGE-PERP-INTX'),
            granularity: z.enum(['ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR', 'ONE_DAY']),
            lookback_candles: z.number().max(5000).default(150).describe('Total number of candles to fetch')
          }),
          execute: async ({ asset, granularity, lookback_candles }) => {
            const apiKeyName = process.env.COINBASE_API_KEY;
            const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');
            if (!apiKeyName || !apiSecret) return { error: "Missing Coinbase Credentials" };

            let coinbaseProduct = asset.toUpperCase().trim();
            if (!coinbaseProduct.includes('-')) {
                if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP-INTX');
            } 
            if (coinbaseProduct.endsWith('-PERP')) {
                coinbaseProduct = coinbaseProduct + '-INTX';
            }

            const apiPath = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
            
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
              while (candlesLeft > 0) {
                const batchSize = Math.min(candlesLeft, 300);
                const currentStart = currentEnd - (batchSize * lookbackSeconds);
                const query = `?start=${currentStart}&end=${currentEnd}&granularity=${granularity}`;

                const token = jwt.sign({
                  iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
                  sub: apiKeyName, uri: `GET api.coinbase.com${apiPath}`,
                }, apiSecret, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

                const resp = await fetch(`https://api.coinbase.com${apiPath}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await resp.json();
                
                if (!resp.ok) {
                    return { error: `Coinbase API Error ${resp.status}: ${data.message || data.error_details || JSON.stringify(data)}` };
                }
                
                if (!data.candles || data.candles.length === 0) break;
                
                allCandles = allCandles.concat(data.candles);
                currentEnd = currentStart;
                candlesLeft -= batchSize;
                
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              
              const formattedCandles = allCandles.map(c => ({ 
                  close: parseFloat(c.close), 
                  high: parseFloat(c.high), 
                  low: parseFloat(c.low), 
                  volume: parseFloat(c.volume) 
              })).reverse();

              const safeData = formattedCandles.slice(-500);

              return { 
                asset: coinbaseProduct, 
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

        runOptimizer: tool({
          description: 'Triggers the genetic optimizer.',
          parameters: z.object({}),
          execute: async () => {
            const url = `https://trading-bot-webhook.vercel.app/api/genetic-optimizer`;
            try {
              const resp = await fetch(url);
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

    result.pipeDataStreamToResponse(res);

  } catch (err) {
    console.error("====== FULL CHAT FAULT ENCOUNTERED ======");
    console.error("NAME:", err.name);
    console.error("MESSAGE:", err.message);
    
    return res.status(500).json({ 
      error: err.message, 
      details: err.cause ? String(err.cause) : "No underlying cause provided by SDK" 
    });
  }
}