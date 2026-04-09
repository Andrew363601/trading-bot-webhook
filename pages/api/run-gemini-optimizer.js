import { createClient } from '@supabase/supabase-js';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * R(ΨC) OPTIMIZER - Vercel AI SDK Version
 * -------------------------------------
 * This version uses the Vercel AI SDK to force structured output,
 * eliminating "Invalid JSON" or "Model Not Found" errors.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  try {
    // 1. Fetch System Context
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(15);
    const { data: current, error: currentErr } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();

    if (currentErr) throw new Error("Active strategy config not found.");

    // 2. Execute Structured Generation
    const { object } = await generateObject({
      model: google('gemini-1.5-flash'), // SDK handles naming aliases automatically
      apiKey: process.env.GEMINI_API_KEY,
      schema: z.object({
        coherence_threshold: z.number().min(0.4).max(0.9),
        lookback_period: z.number().int().min(5).max(30),
        reasoning: z.string()
      }),
      prompt: `Act as an elite quantitative researcher. 
               Current Strategy: ${JSON.stringify(current.parameters)}
               Recent History: ${logs.length === 0 ? 'COLD START (No data)' : JSON.stringify(logs)}
               
               Optimize 'coherence_threshold' and 'lookback_period' for better win rate. 
               Provide a brief reasoning for the shift.`,
    });

    // 3. Update Supabase with the optimized object
    const nextVer = (parseFloat(current.version || "1.0") + 0.1).toFixed(1);
    const { error: updateErr } = await supabase
      .from('strategy_config')
      .update({ 
        parameters: {
            coherence_threshold: object.coherence_threshold,
            lookback_period: object.lookback_period
        }, 
        version: nextVer, 
        last_updated: new Date().toISOString() 
      })
      .eq('id', current.id);

    if (updateErr) throw updateErr;

    return res.status(200).json({ 
        message: `Nexus Actualized to v${nextVer}. AI Reasoning: ${object.reasoning}`,
        parameters: object 
    });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}