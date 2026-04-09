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

    const { data: activeConfigs } = await supabase.from('strategy_config').select('*').eq('is_active', true);
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(5);
    const { data: latestScans } = await supabase.from('scan_results').select('*').order('created_at', { ascending: false }).limit(10);
    
    const systemPrompt = `
        You are Nexus, the elite Portfolio Architect. You manage an autonomous fleet of quantitative strategies for Andrew.
        You evaluate if current market metrics are "Fit" for deployment.
        
        --- YOUR IDENTITY ---
        1. PERSONA: Sleek, technical, calculated, and high-efficiency. You communicate like a quant-trader, not a general assistant.
        2. AUTHORITY: You have full CRUD (Create, Read, Update, Delete) access to the strategy matrix via the manageStrategy tool.
        3. GOAL: Maximize ROI while maintaining strict risk management.
      
        --- CURRENT TELEMETRY ---
        Active Strategies Matrix: ${JSON.stringify(activeConfigs || [])}
      
        --- HISTORICAL PERFORMANCE (FEEDBACK LOOP) ---
        Recent Trade Data: ${JSON.stringify(logs || [])}
    
        --- RECENT SCAN DATA (MEMORY) ---
        ${JSON.stringify(latestScans || [])}
      
        --- OPERATIONAL PROTOCOL ---
        - Analyze if the Trigger MCI is rising or falling compared to the Macro trend. 
        - If Andrew asks about a coin, check the memory above to see if it's nearing Resonance.
        - If Andrew asks to "Start a new strategy" for a coin, use manageStrategy to create the record.
        - If trade logs show consistent losses, analyze the parameters (MCI threshold, etc.) and suggest a mutation.
        - You are authorized to toggle between PAPER and LIVE if Andrew provides the command.
        - Keep responses under 3 sentences unless explaining complex math logic.
    `;

    const result = await streamText({
      model: google('gemini-2.0-flash'),
      system: systemPrompt,
      messages,
      maxSteps: 5,
      tools: {
        manageStrategy: tool({
          description: 'Creates or updates a strategy configuration for a specific asset. Use this to spawn new strategies or toggle existing ones.',
          parameters: z.object({
            asset: z.string().describe('The asset symbol, e.g., DOGE-USDT'),
            strategy_id: z.string().describe('The name of the logic, e.g., LTC_4x4_STF or MOMENTUM_SCALPER'),
            execution_mode: z.enum(['LIVE', 'PAPER']).optional(),
            is_active: z.boolean().optional(),
            parameters: z.record(z.any()).optional()
          }),
          execute: async (args) => {
            // This uses Supabase .upsert() - it updates if the ID matches, otherwise it creates a new row.
            const { data, error } = await supabase
              .from('strategy_config')
              .upsert({
                asset: args.asset,
                strategy: args.strategy_id,
                execution_mode: args.execution_mode || 'PAPER',
                is_active: args.is_active ?? true,
                parameters: args.parameters || {},
                last_updated: new Date().toISOString(),
                version: "1.0"
              }, { onConflict: 'asset, strategy' }) // Prevents duplicate rows for the same coin/strategy
              .select();
      
            if (error) return { success: false, error: error.message };
            return { success: true, message: `Nexus has deployed ${args.strategy_id} for ${args.asset}.` };
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