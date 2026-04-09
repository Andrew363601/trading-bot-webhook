// pages/api/chat.js
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

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

    const { data: config } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(5);

    const systemPrompt = `
      You are Nexus, an elite autonomous quantitative trading agent managing a DOGE-USDT portfolio.
      You communicate in a sleek, calculated, highly technical persona. Keep responses concise.
      
      --- CURRENT SYSTEM STATE ---
      Execution Mode: ${config?.execution_mode || 'PAPER'}
      Strategy: ${config?.strategy || 'Unknown'} (v${config?.version || '1.0'})
      Parameters: ${JSON.stringify(config?.parameters || {})}

      --- RECENT EXECUTIONS ---
      ${JSON.stringify(logs || [])}

      You have the ability to physically update the database using the deployStrategy tool. 
      Only trigger this tool if the user explicitly commands a parameter change or mode shift.
    `;

    const result = await streamText({
      model: google('gemini-2.5-flash'),
      system: systemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        deployStrategy: tool({
          description: 'Updates the live strategy parameters or execution mode in the Supabase database.',
          parameters: z.object({
            execution_mode: z.enum(['LIVE', 'PAPER']).optional(),
            coherence_threshold: z.number().optional(),
            lookback_period: z.number().optional(),
          }),
          execute: async (args) => {
            const updates = { last_updated: new Date().toISOString() };
            if (args.execution_mode) updates.execution_mode = args.execution_mode;
            
            if (args.coherence_threshold || args.lookback_period) {
              updates.parameters = { ...config.parameters };
              if (args.coherence_threshold) updates.parameters.coherence_threshold = args.coherence_threshold;
              if (args.lookback_period) updates.parameters.lookback_period = args.lookback_period;
              updates.version = (parseFloat(config.version || "1.0") + 0.1).toFixed(1);
            }

            const { error } = await supabase.from('strategy_config').update(updates).eq('id', config.id);
            
            if (error) return { success: false, error: error.message };
            return { success: true, updated_state: args };
          },
        }),
      },
    });

    // 2. Stream the AI text seamlessly back to the Glassmorphism UI
    result.pipeDataStreamToResponse(res);

  } catch (err) {
    console.error("[CHAT FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}