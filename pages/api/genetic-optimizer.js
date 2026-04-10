// pages/api/genetic-optimizer.js
import { createClient } from '@supabase/supabase-js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const { data: configs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
    if (!configs || configs.length === 0) return res.status(200).json({ status: "No active strategies to optimize." });

    const mutations = [];

    for (const config of configs) {
      // FIX: Only fetch trades that match this EXACT strategy and version
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('pnl, side, entry_price, exit_price')
        .eq('symbol', config.asset.replace('-', ''))
        .eq('strategy_id', config.strategy)
        .eq('version', config.version || 'v1.0')
        .not('exit_price', 'is', null) // Only look at closed trades
        .order('id', { ascending: false })
        .limit(20);

      if (!trades || trades.length < 3) continue;

      const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const winningTrades = trades.filter(t => t.pnl > 0).length;
      const winRate = (winningTrades / trades.length) * 100;

      const prompt = `
        You are the Nexus Genetic Optimizer. Mutate the parameters of this trading strategy to increase profitability.
        
        --- ACTIVE CONFIGURATION ---
        Asset: ${config.asset}
        Strategy: ${config.strategy}
        Version: ${config.version || 'v1.0'}
        Current Parameters: ${JSON.stringify(config.parameters)}
        
        --- RECENT PERFORMANCE ---
        Total PnL: ${totalPnL.toFixed(4)}
        Win Rate: ${winRate.toFixed(1)}%
        Trade History: ${JSON.stringify(trades)}

        --- DIRECTIVE ---
        If the Win Rate is below 75% or PnL is negative, mutate the parameters to be stricter.
        If the Win Rate is high, attempt a micro-mutation to optimize for earlier entries.
        
        CRITICAL: Respond ONLY with RAW JSON. Do NOT use markdown formatting or code blocks.
        {
          "parameters": { "coherence_threshold": 0.75, "adx_len": 14 },
          "reasoning": "Tightened threshold to reduce false positives."
        }
      `;

      const { text } = await generateText({
        model: google('models/gemini-2.5-flash'),
        prompt: prompt
      });

      try {
        // FIX: The Markdown Scrubber. Rips out ```json and ``` if the AI disobeys.
        let cleanJSON = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
        const firstBrace = cleanJSON.indexOf('{');
        const lastBrace = cleanJSON.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            cleanJSON = cleanJSON.substring(firstBrace, lastBrace + 1);
        }

        const mutation = JSON.parse(cleanJSON);
        
        const oldVersion = parseFloat(config.version?.replace('v', '') || '1.0');
        const newVersion = `v${(oldVersion + 0.1).toFixed(1)}`;

        // Update the database with the evolved version
        await supabase.from('strategy_config').update({
          parameters: mutation.parameters,
          reasoning: `[AUTO-EVOLVED] ${mutation.reasoning}`,
          version: newVersion,
          last_updated: new Date().toISOString()
        }).eq('id', config.id);

        mutations.push({
          asset: config.asset,
          strategy: config.strategy,
          old_version: config.version,
          new_version: newVersion,
          reasoning: mutation.reasoning
        });
        
      } catch (parseErr) {
        console.error(`[OPTIMIZER JSON ERROR] Failed on ${config.asset}:`, parseErr.message, text);
      }
    }

    return res.status(200).json({ status: "Evolution Cycle Complete", mutations });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}