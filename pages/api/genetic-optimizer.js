// Unleashing Vercel Pro limit (5 full minutes!)
export const maxDuration = 300;

// pages/api/genetic-optimizer.js
import { createClient } from '@supabase/supabase-js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const apiKeyName = process.env.COINBASE_API_KEY;
    const apiSecret = process.env.COINBASE_API_SECRET?.replace(/\\n/g, '\n');

    const { data: configs } = await supabase.from('strategy_config').select('*');
    if (!configs || configs.length === 0) return res.status(200).json({ status: "No strategies found." });

    const portfolioActions = [];
    
    // THE 48-HOUR ROLLING WINDOW
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    for (const config of configs) {
      // 1. FORCE-FEED: Look at Supabase Logs (Strict 48-Hour Timeframe)
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('pnl, side, entry_price, exit_price, exit_time')
        .eq('symbol', config.asset) // Fixed the hyphen-stripping bug
        .eq('strategy_id', config.strategy)
        .not('exit_price', 'is', null)
        .gte('exit_time', fortyEightHoursAgo) // Only trades from the last 48 hours
        .order('exit_time', { ascending: false });

      // If it's active but hasn't traded in 48 hours, the AI will see an empty array 
      // and can decide if it's dead in the water (PAUSE) or just waiting for a setup (MAINTAIN).
      const totalPnL = trades ? trades.reduce((sum, t) => sum + (t.pnl || 0), 0) : 0;
      const winningTrades = trades ? trades.filter(t => t.pnl > 0).length : 0;
      const winRate = trades && trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;

      // 2. FORCE-FEED: Read Strategy Source Code
      let strategyLogic = "Source code unavailable.";
      try {
          const fileName = `${config.strategy.toLowerCase()}.js`;
          const filePath = path.join(process.cwd(), 'lib', 'strategies', fileName);
          if (fs.existsSync(filePath)) {
              strategyLogic = fs.readFileSync(filePath, 'utf8');
          } else {
              console.warn(`[OPTIMIZER WARN] Could not find file for ${config.strategy}`);
          }
      } catch (err) {
          console.error(`[OPTIMIZER FS ERROR]`, err.message);
      }

      // 3. FORCE-FEED: Fetch Historical Data
      let marketContext = [];
      const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';
      
      if (apiKeyName && apiSecret) {
        let coinbaseProduct = config.asset.toUpperCase().trim();
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
        switch (triggerTf) {
            case 'ONE_MINUTE': lookbackSeconds = 60; break;
            case 'FIVE_MINUTE': lookbackSeconds = 300; break;
            case 'FIFTEEN_MINUTE': lookbackSeconds = 900; break;
            case 'ONE_HOUR': lookbackSeconds = 3600; break;
            case 'ONE_DAY': lookbackSeconds = 86400; break;
            default: lookbackSeconds = 300;
        }

        let allCandles = [];
        let currentEnd = Math.floor(Date.now() / 1000);
        let candlesLeft = 600; 
        
        while (candlesLeft > 0) {
            const batchSize = Math.min(candlesLeft, 300);
            const currentStart = currentEnd - (batchSize * lookbackSeconds);
            const query = `?start=${currentStart}&end=${currentEnd}&granularity=${triggerTf}`;

            const token = jwt.sign({
                iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
                sub: apiKeyName, uri: `GET api.coinbase.com${apiPath}`,
            }, apiSecret, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

            const resp = await fetch(`https://api.coinbase.com${apiPath}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!resp.ok) break;
            const data = await resp.json();
            if (!data.candles || data.candles.length === 0) break;

            allCandles = allCandles.concat(data.candles);
            currentEnd = currentStart;
            candlesLeft -= batchSize;
        }

        marketContext = allCandles.map(c => ({ 
            close: parseFloat(c.close), 
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            volume: parseFloat(c.volume) 
        })).reverse().slice(-500);
      }

      // 4. THE OMNISCIENT PROMPT - Timeframe Context Added
      const prompt = `
      You are the Nexus Quantitative Portfolio Manager. Your task is to evaluate this trading strategy against the current market regime and manage its deployment.
      
      --- CONFIGURATION ---
      Asset: ${config.asset}
      Strategy Name: ${config.strategy}
      Status: ${config.is_active ? 'ACTIVE' : 'PAUSED'}
      Current Version: ${config.version || 'v1.0'}
      Current Parameters: ${JSON.stringify(config.parameters)}
      
      --- RAW STRATEGY SOURCE CODE ---
      Read this logic to understand its core market approach (e.g., trend following, mean reversion, breakout):
      ${strategyLogic}
      
      --- TELEMETRY (Last 48 Hours) ---
      Number of Trades Taken: ${trades ? trades.length : 0}
      Total Net PnL: $${totalPnL.toFixed(4)}
      Win Rate: ${winRate.toFixed(1)}%
      Recent Trades Data: ${JSON.stringify(trades)}
      
      --- MARKET CONTEXT ---
      Recent Market Context (Last 500 ${triggerTf} candles): ${JSON.stringify(marketContext)}

      --- DIRECTIVE ---
      Analyze the Market Context and the Strategy Logic. Determine the current market regime (e.g., trending, ranging, volatile chop).
      
      You must choose ONE of the following actions:
      1. PAUSE: If the strategy is ACTIVE, but its core logic is fundamentally unsuited for the current market regime (e.g., it's a trend-follower bleeding in a choppy market). Mutating won't fix a regime mismatch.
      2. REACTIVATE: If the strategy is PAUSED, but the recent 500 candles show a regime that perfectly matches this strategy's source code logic.
      3. MUTATE: If the strategy is ACTIVE, suited for the regime, but needs parameter tuning (e.g., wider stops, faster EMA) to increase ROI. You must retain the exact parameter keys.
      4. MAINTAIN: If the strategy is ACTIVE and perfectly tuned for the current regime, or PAUSED and the regime is still wrong for it.

      If MUTATE, increment the version by 0.1 (e.g., v1.0 to v1.1). Otherwise, keep the current version.
      `;

      // 5. STRUCTURED GENERATION
      const { object } = await generateObject({
        model: google('gemini-2.5-pro'),
        mode: 'json', // <--- THE WEB FIX: Forces Vercel to bypass the registry check
        system: "You are a quantitative portfolio manager. Output strictly valid JSON. You MUST retain exact parameter keys.",
        schema: z.object({
          action: z.enum(["MUTATE", "PAUSE", "REACTIVATE", "MAINTAIN"]).describe("The strategic deployment decision."),
          parameters: z.record(z.any()).describe(`The parameter object. Modify ONLY if action is MUTATE.`),
          new_version: z.string().describe("Incremented version if MUTATE, otherwise keep current version."),
          reasoning: z.string().describe("Regime-based and mathematical reasoning for this decision.")
        }),
        prompt: prompt
      });
// 6. DATABASE DEPLOYMENT
let is_active_new = config.is_active;
if (object.action === 'PAUSE') is_active_new = false;
if (object.action === 'REACTIVATE') is_active_new = true;

// Execute update only if an action was taken to minimize DB writes
if (object.action !== 'MAINTAIN') {
    // 1. Update the live configuration
    await supabase.from('strategy_config').update({
      is_active: is_active_new,
      parameters: object.parameters || config.parameters,
      reasoning: `[AUTO-${object.action}] ${object.reasoning}`,
      version: object.new_version || config.version,
      last_updated: new Date().toISOString()
    }).eq('id', config.id);

    // 2. NEW: Save the exact historical reasoning to the ledger for Nexus to read
    await supabase.from('optimization_logs').insert({
      asset: config.asset,
      strategy: config.strategy,
      action: object.action,
      old_version: config.version,
      new_version: object.new_version || config.version,
      reasoning: object.reasoning,
      parameters: object.parameters || config.parameters
    });
}

portfolioActions.push({
  asset: config.asset,
  strategy: config.strategy,
  action: object.action,
  reasoning: object.reasoning
});
    }

    return res.status(200).json({ status: "Portfolio Evaluation Complete", portfolioActions });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}