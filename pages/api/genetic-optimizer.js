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
    // 1. Fetch all active strategies
    const { data: configs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
    if (!configs) return res.status(200).json({ status: "No active strategies to optimize." });

    const mutations = [];

    for (const config of configs) {
      // 2. Fetch the last 20 trades for this specific asset
      const { data: trades } = await supabase
        .from('trade_logs')
        .select('pnl, side, entry_price, exit_price')
        .eq('symbol', config.asset.replace('-', ''))
        .order('id', { ascending: false })
        .limit(20);

      // We need at least 3 trades to establish a statistical baseline
      if (!trades || trades.length < 3) continue;

      const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const winningTrades = trades.filter(t => t.pnl > 0).length;
      const winRate = (winningTrades / trades.length) * 100;

      // 3. The LLM acts as the Genetic Mutator
      const prompt = `
        You are the Nexus Genetic Optimizer. You evaluate trading algorithms and mutate their parameters to increase alpha.
        
        --- ASSET & STRATEGY ---
        Asset: ${config.asset}
        Strategy: ${config.strategy}
        Current Parameters: ${JSON.stringify(config.parameters)}
        
        --- RECENT PERFORMANCE ---
        Total PnL: ${totalPnL.toFixed(4)}
        Win Rate: ${winRate.toFixed(1)}%
        Trade History: ${JSON.stringify(trades)}

        --- DIRECTIVE ---
        If the Win Rate is below 75% or PnL is negative, mutate the parameters to be stricter (e.g., raise coherence_threshold, increase RSI lengths, or demand higher volume spikes).
        If the Win Rate is high, attempt a micro-mutation to optimize for slightly earlier entries.
        
        Respond ONLY with a valid JSON object in this exact format, with no markdown formatting:
        {
          "parameters": { "coherence_threshold": 0.75, "adx_len": 14 },
          "reasoning": "Tightened threshold because win rate was 40% and PnL was bleeding. Higher threshold reduces false positives in current chop."
        }
      `;

      const { text } = await generateText({
        model: google('models/gemini-2.0-flash'),
        prompt: prompt
      });

      // 4. Parse the LLM's mutation
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const mutation = JSON.parse(jsonMatch[0]);
          
          // Generate a new version number (e.g. v1.1, v1.2)
          const oldVersion = parseFloat(config.version?.replace('v', '') || '1.0');
          const newVersion = `v${(oldVersion + 0.1).toFixed(1)}`;

          // 5. Inject the evolved parameters back into the database
          await supabase.from('strategy_config').update({
            parameters: mutation.parameters,
            reasoning: `[AUTO-EVOLVED] ${mutation.reasoning}`,
            version: newVersion,
            last_updated: new Date().toISOString()
          }).eq('id', config.id);

          mutations.push({
            asset: config.asset,
            old_pnl: totalPnL,
            new_version: newVersion,
            reasoning: mutation.reasoning
          });
        }
      } catch (parseErr) {
        console.error(`Failed to parse mutation for ${config.asset}:`, parseErr);
      }
    }

    return res.status(200).json({ status: "Evolution Cycle Complete", mutations });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}