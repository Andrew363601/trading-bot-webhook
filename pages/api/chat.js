// pages/api/chat.js
import { google } from '@ai-sdk/google';
import { streamText } from 'ai';
import { createClient } from '@supabase/supabase-js';

// We use the Edge runtime for instant character-by-character streaming
export const runtime = 'edge';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { messages } = await req.json();

    // 1. Initialize Supabase inside the Edge Route
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 2. Fetch the Live Context
    const { data: config } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(5);

    // 3. The "God Prompt" - Injecting Supabase data directly into the Agent's brain
    const systemPrompt = `
      You are Nexus, an elite autonomous quantitative trading agent managing a DOGE-USDT portfolio.
      You communicate in a sleek, calculated, highly technical persona. 
      Keep responses concise, analytical, and professional. Do not use markdown headers, just raw text.

      --- CURRENT SYSTEM STATE ---
      Execution Mode: ${config?.execution_mode || 'PAPER'}
      Strategy: ${config?.strategy || 'Unknown'} (v${config?.version || '1.0'})
      Parameters: ${JSON.stringify(config?.parameters || {})}

      --- RECENT EXECUTIONS (LAST 5 TRADES) ---
      ${JSON.stringify(logs || [])}

      Use this exact data to answer the user's queries about past performance, strategy logic, or current configurations.
    `;

    // 4. Stream the Response using the correct, live model
    const result = await streamText({
      model: google('gemini-2.5-flash'), 
      system: systemPrompt,
      messages,
    });

    return result.toDataStreamResponse();

  } catch (err) {
    console.error("[CHAT FAULT]:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}