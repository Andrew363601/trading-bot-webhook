export const maxDuration = 60; // Unlocks Vercel's 60-second execution limit

// pages/api/genetic-optimizer.js
import { createClient } from '@supabase/supabase-js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

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

    const { data: configs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
    if (!configs || configs.length === 0) return res.status(200).json({ status: "No active strategies to optimize." });

    const mutations = [];

    for (const config of configs) {
      // 1. Fetch trades strictly isolated to this version
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('pnl, side, entry_price, exit_price, exit_time')
        .eq('symbol', config.asset.replace('-', ''))
        .eq('strategy_id', config.strategy)
        .eq('version', config.version || 'v1.0')
        .not('exit_price', 'is', null)
        .order('id', { ascending: false })
        .limit(20);

      if (!trades || trades.length < 3) continue;

      const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const winningTrades = trades.filter(t => t.pnl > 0).length;
      const winRate = (winningTrades / trades.length) * 100;

      // 2. THE RESEARCHER LOOP: Deep Paginated Fetch based on Strategy Timeframe
      let marketContext = [];
      const triggerTf = config.parameters?.trigger_tf || 'FIVE_MINUTE';
      
      if (apiKeyName && apiSecret) {
       // Replace the old path builder with this:
       const cleanAsset = config.asset.replace(/-/g, '');
       const coinbaseProduct = cleanAsset.replace('USDT', '-USDT').replace('USD', '-USD');
       const path = `/api/v3/brokerage/products/${coinbaseProduct}/candles`;
        
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
        let candlesLeft = 600; // Pulling 600 candles of deep historical context
        
        while (candlesLeft > 0) {
            const batchSize = Math.min(candlesLeft, 300);
            const currentStart = currentEnd - (batchSize * lookbackSeconds);
            const query = `?start=${currentStart}&end=${currentEnd}&granularity=${triggerTf}`;

            const token = jwt.sign({
                iss: 'cdp', nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120,
                sub: apiKeyName, uri: `GET api.coinbase.com${path}`,
            }, apiSecret, { algorithm: 'ES256', header: { kid: apiKeyName, nonce: crypto.randomBytes(16).toString('hex') } });

            const resp = await fetch(`https://api.coinbase.com${path}${query}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!resp.ok) break;
            const data = await resp.json();
            if (!data.candles || data.candles.length === 0) break;

            allCandles = allCandles.concat(data.candles);
            currentEnd = currentStart;
            candlesLeft -= batchSize;
        }

        // Slice down slightly to respect context limits but provide enough trend data
        marketContext = allCandles.map(c => ({ close: parseFloat(c.close), volume: parseFloat(c.volume) })).reverse().slice(-150);
      }

      // 3. THE OMNISCIENT PROMPT
      const prompt = `
        You are the Nexus Genetic Optimizer. Your task is to mathematically mutate the parameters of this trading strategy to increase ROI.
        
        --- ACTIVE CONFIGURATION ---
        Asset: ${config.asset}
        Strategy Architecture: ${config.strategy}
        Current Version: ${config.version || 'v1.0'}
        Current Parameters: ${JSON.stringify(config.parameters)}
        
        --- TELEMETRY ---
        Total PnL: $${totalPnL.toFixed(4)}
        Win Rate: ${winRate.toFixed(1)}%
        Recent Trades: ${JSON.stringify(trades)}
        Recent Market Context (Last 150 ${triggerTf} candles): ${JSON.stringify(marketContext)}

        --- DIRECTIVE ---
        1. Analyze the Market Context. Did the strategy lose because the timeframe was too noisy? Was the stop-loss too tight during consolidation?
        2. Mutate the parameters. You are fully authorized to change:
           - Timeframes: 'macro_tf' and 'trigger_tf' (Valid: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, ONE_HOUR, ONE_DAY)
           - Risk Controls: 'leverage' (1 to 10), 'tp_percent' (e.g., 0.02 for 2%), 'sl_percent' (e.g., 0.01 for 1%)
           - Core logic thresholds specific to this strategy architecture.
        3. You MUST increment the version number by exactly 0.1 (e.g., v1.0 becomes v1.1).
      `;

      // 4. STRUCTURED GENERATION (No more manual JSON scrubbing)
      const { object } = await generateObject({
        model: google('models/gemini-2.5-flash'),
        system: "You are a quantitative genetic algorithm. Output strictly valid JSON parameters and incremented version numbers.",
        schema: z.object({
          parameters: z.record(z.any()).describe("The complete, evolved parameter JSON object"),
          new_version: z.string().describe("The incremented version string, e.g., v1.1"),
          reasoning: z.string().describe("Mathematical and market-context reasoning for this mutation.")
        }),
        prompt: prompt
      });

      // 5. DATABASE DEPLOYMENT
      await supabase.from('strategy_config').update({
        parameters: object.parameters,
        reasoning: `[AUTO-EVOLVED] ${object.reasoning}`,
        version: object.new_version,
        last_updated: new Date().toISOString()
      }).eq('id', config.id);

      mutations.push({
        asset: config.asset,
        strategy: config.strategy,
        old_version: config.version,
        new_version: object.new_version,
        reasoning: object.reasoning
      });
    }

    return res.status(200).json({ status: "Evolution Cycle Complete", mutations });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}