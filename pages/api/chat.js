// Unleashing Vercel Pro limit (5 full minutes)
export const maxDuration = 300;

// pages/api/chat.js
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { recordUsage } from '../../lib/usage-meter';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) {}
    }

    const messages = data?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("Invalid or empty message payload.");
    }

    const safeMessages = messages.length > 15 ? messages.slice(-15) : messages;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseKey) throw new Error("Missing Supabase Keys in environment.");
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const authHeader = req.headers.authorization;
    let tenantId = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const { payload } = await jwtVerify(token, JWKS, { algorithms: ['ES256'] });
      
      const { data: userLink } = await supabase
        .from('tenant_users')
        .select('tenant_id')
        .eq('auth_user_id', payload.sub)
        .single();
      
      tenantId = userLink?.tenant_id;
    }

    // HARD ENFORCEMENT: Reject unauthenticated requests to prevent cross-tenant data leakage
    if (!tenantId) {
      console.error("[CHAT API SECURITY] Rejected request with no valid tenant_id.");
      return res.status(401).json({ error: 'Authentication required. Valid tenant session not found.' });
    }

    // Track Chat Usage
    await recordUsage(tenantId, 'CHAT_MESSAGE', 1);

    console.log(`[CHAT API] Request for tenant: ${tenantId}. Message count: ${safeMessages.length}`);

    // Helper for timeouts
    const withTimeout = (promise, ms = 15000, fallback = { data: [], error: 'Timeout' }) => 
        Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve(fallback), ms))
        ]);

    let strategyQuery = supabase.from('strategy_config').select('*').eq('tenant_id', tenantId);
    let tradeLogQuery = supabase.from('trade_logs').select('*').is('exit_price', null).eq('tenant_id', tenantId);
    let recentLogQuery = supabase.from('trade_logs').select('*').not('exit_price', 'is', null).order('id', { ascending: false }).limit(5).eq('tenant_id', tenantId);

    // Execute queries with timeouts
    const configsRes = await withTimeout(strategyQuery);
    const tradesRes = await withTimeout(tradeLogQuery);
    const closedRes = await withTimeout(recentLogQuery);

    const allConfigs = configsRes.data || [];
    const openTrades = tradesRes.data || [];
    const recentClosedLogs = closedRes.data || [];
    
    let livePrices = {};
    if (openTrades && openTrades.length > 0) {
      const uniqueAssets = [...new Set(openTrades.map(t => t.symbol))];
      
      await Promise.all(uniqueAssets.map(async (asset) => {
        if (!asset || typeof asset !== 'string') return; 
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
      }));
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

    const result = await streamText({
      model: google('gemini-3-flash-preview'),
      system: systemPrompt,
      messages: safeMessages, 
      maxSteps: 10,
      experimental_output: { type: 'text' },
      tools: {
        queryTradeLedger: tool({
          description: 'Queries the complete historical trade ledger to calculate PnL, Win Rate, and filter by asset, strategy, or timeframe.',
          parameters: z.object({
            asset: z.string().optional().describe('Filter by asset symbol, e.g., DOGE-PERP-INTX. Leave undefined for all assets.'),
            strategy_id: z.string().optional().describe('Filter by strategy, e.g., KELTNER_EXECUTION_V1. Leave undefined for all strategies.'),
            days_back: z.number().optional().describe('Number of days back to search (e.g., 7 for this week). Leave undefined for all-time.')
          }),
          execute: async ({ asset, strategy_id, days_back }) => {
            const runQuery = async () => {
                let query = supabase.from('trade_logs').select('*').not('exit_price', 'is', null).eq('tenant_id', tenantId);

                if (asset) query = query.eq('symbol', asset);
                if (strategy_id) query = query.eq('strategy_id', strategy_id);
                if (days_back) {
                const dateLimit = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
                query = query.gte('exit_time', dateLimit);
                }

                const { data: trades, error } = await query;
                if (error) throw error;
                return trades;
            };

            try {
                const trades = await Promise.race([
                    runQuery(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 10000))
                ]);

                const tradesList = trades || [];
                const totalTrades = tradesList.length;
                const totalPnL = tradesList.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
                const winningTrades = tradesList.filter(t => parseFloat(t.pnl) > 0).length;
                const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) + '%' : '0%';

                const breakdown = tradesList.reduce((acc, t) => {
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
            } catch (err) {
                console.error("[SUPABASE ERROR] Error during queryTradeLedger execution:", err.message);
                return { error: `Exception during queryTradeLedger: ${err.message}` };
            }
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
            const runManage = async () => {
                const { data: existing, error: existingError } = await supabase
                .from('strategy_config')
                .select('id')
                .eq('asset', args.asset)
                .eq('strategy', args.strategy_id)
                .eq('tenant_id', tenantId)
                .maybeSingle();

                if (existingError) throw existingError;

                const payload = {
                tenant_id: tenantId,
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
                result = await supabase.from('strategy_config').update(payload).eq('id', existing.id).eq('tenant_id', tenantId);
                } else {
                result = await supabase.from('strategy_config').insert([payload]);
                }
        
                if (result.error) throw result.error;
                return { success: true, message: `Strategy ${args.strategy_id} updated to ${payload.version}.` };
            };

            try {
                return await Promise.race([
                    runManage(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Strategy update timeout')), 10000))
                ]);
            } catch (err) {
                console.error("[SUPABASE ERROR] Error during manageStrategy execution:", err.message);
                return { success: false, error: `Exception during manageStrategy: ${err.message}` };
            }
          },
        }), 

        readStrategyLogic: tool({
          description: 'Reads the raw JavaScript source code of a specific strategy file.',
          parameters: z.object({
            fileName: z.string().optional().describe('The name of the strategy file to read, e.g., "doge_hf_scalper_v1.js"'),
            strategy_name: z.string().optional().describe('The name of the strategy to read, e.g., "ORACLE_PRICE_ACTION_V1"')
          }),
          execute: async ({ fileName, strategy_name }) => {
            try {
              const resolvedName = fileName || (strategy_name ? `${strategy_name.toLowerCase()}.js` : '');
              if (!resolvedName) return { error: "Missing fileName or strategy_name" };
              const safeFileName = path.basename(resolvedName);
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
            asset: z.string().optional().describe('The asset symbol, e.g., DOGE-PERP-INTX'),
            symbol: z.string().optional().describe('The asset symbol, e.g., DOGE-PERP-INTX (alias for asset)'),
            granularity: z.union([z.enum(['ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_HOUR', 'ONE_DAY']), z.string()]).optional().describe('Candle granularity: enum string, short string (1m, 1h), or seconds number (60, 300, 900, 3600, 86400). Defaults to ONE_HOUR.'),
            lookback_candles: z.number().max(5000).optional().describe('Total number of candles to fetch. Defaults to 150.'),
            limit: z.number().max(5000).optional().describe('Alias for lookback_candles.')
          }),
          execute: async ({ asset, symbol, granularity = 'ONE_HOUR', lookback_candles, limit }) => {
            const runFetch = async () => {
              const resolvedAsset = asset || symbol;
              if (!resolvedAsset) throw new Error("Missing asset symbol");
              
              const granularityMapping = {
                'ONE_MINUTE': 'ONE_MINUTE', '1m': 'ONE_MINUTE', '60': 'ONE_MINUTE', 60: 'ONE_MINUTE',
                'FIVE_MINUTE': 'FIVE_MINUTE', '5m': 'FIVE_MINUTE', '300': 'FIVE_MINUTE', 300: 'FIVE_MINUTE',
                'FIFTEEN_MINUTE': 'FIFTEEN_MINUTE', '15m': 'FIFTEEN_MINUTE', '900': 'FIFTEEN_MINUTE', 900: 'FIFTEEN_MINUTE',
                'ONE_HOUR': 'ONE_HOUR', '1h': 'ONE_HOUR', '3600': 'ONE_HOUR', 3600: 'ONE_HOUR',
                'ONE_DAY': 'ONE_DAY', '1d': 'ONE_DAY', '86400': 'ONE_DAY', 86400: 'ONE_DAY',
              };
              const resolvedGranularity = granularityMapping[String(granularity).toLowerCase()] || 'ONE_HOUR';
              const resolvedLookback = lookback_candles || limit || 150;
              
              const apiKeyName = process.env.COINBASE_API_KEY;
              const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');
              if (!apiKeyName || !apiSecret) throw new Error("Missing Coinbase Credentials");

              let coinbaseProduct = resolvedAsset.toUpperCase().trim();
              if (!coinbaseProduct.includes('-')) {
                  if (coinbaseProduct.endsWith('USDT')) coinbaseProduct = coinbaseProduct.replace('USDT', '-USDT');
                  else if (coinbaseProduct.endsWith('USD')) coinbaseProduct = coinbaseProduct.replace('USD', '-USD');
                  else if (coinbaseProduct.endsWith('PERP')) coinbaseProduct = coinbaseProduct.replace('PERP', '-PERP-INTX');
              } 
              if (coinbaseProduct.endsWith('-PERP')) coinbaseProduct = coinbaseProduct + '-INTX';

              const apiPath = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
              let lookbackSeconds = 3600;
              if (resolvedGranularity === 'ONE_MINUTE') lookbackSeconds = 60;
              else if (resolvedGranularity === 'FIVE_MINUTE') lookbackSeconds = 300;
              else if (resolvedGranularity === 'FIFTEEN_MINUTE') lookbackSeconds = 900;
              else if (resolvedGranularity === 'ONE_DAY') lookbackSeconds = 86400;

              let allCandles = [];
              let currentEnd = Math.floor(Date.now() / 1000);
              let candlesLeft = resolvedLookback;

              const privateKey = crypto.createPrivateKey({ key: apiSecret, format: 'pem' });

              while (candlesLeft > 0) {
                const batchSize = Math.min(candlesLeft, 300);
                const currentStart = currentEnd - (batchSize * lookbackSeconds);
                const query = `?start=${currentStart}&end=${currentEnd}&granularity=${resolvedGranularity}`;

                const token = jwt.sign({
                  iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
                  sub: apiKeyName, uri: `GET api.coinbase.com${apiPath}`,
                }, privateKey, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

                const resp = await fetch(`https://api.coinbase.com${apiPath}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await resp.json();
                
                if (!resp.ok) throw new Error(`Coinbase API Error: ${JSON.stringify(data)}`);
                if (!data.candles || data.candles.length === 0) break;
                
                allCandles = allCandles.concat(data.candles);
                currentEnd = currentStart;
                candlesLeft -= batchSize;
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              
              const formattedCandles = allCandles.map(c => ({ close: parseFloat(c.close), high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) })).reverse();
              return { asset: coinbaseProduct, granularity: resolvedGranularity, data: formattedCandles.slice(-500) };
            };

            try {
              return await Promise.race([
                runFetch(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Historical data fetch timeout')), 25000))
              ]);
            } catch (err) {
              return { error: err.message };
            }
          }
        }),

        runOptimizer: tool({
          description: 'Triggers the genetic optimizer.',
          parameters: z.object({}),
          execute: async () => {
            const runOpt = async () => {
              const host = req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
              const protocol = host.includes('localhost') ? 'http' : 'https';
              const url = `${protocol}://${host}/api/genetic-optimizer`;
              
              const resp = await fetch(url);
              if (!resp.ok) {
                  const errorText = await resp.text();
                  throw new Error(`Server returned ${resp.status}: ${errorText}`);
              }
              return await resp.json();
            };

            try {
              const result = await Promise.race([
                runOpt(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Optimizer trigger timeout')), 15000))
              ]);
              return { success: true, data: result };
            } catch (e) {
              return { success: false, error: e.message };
            }
          },
        }),
      },
    });

    // 🟢 THE FIX: Use result.text (Promise<string>) — stable across all ai v6.x versions
    const text = await result.text;
    res.setHeader('Content-Type', 'text/plain');
    // Gemini 3 sometimes returns empty text after thought tokens + function calls
    res.write(text || 'I have analyzed the data and am ready to proceed. What specific information would you like me to share?');
    res.end();

  } catch (err) {
    console.error("====== FULL CHAT FAULT ENCOUNTERED ======");
    console.error("MESSAGE:", err.message);
    
    return res.status(500).json({ 
      error: err.message, 
      details: err.cause ? String(err.cause) : "No underlying cause provided by SDK" 
    });
  }
}