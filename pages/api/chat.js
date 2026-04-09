// pages/api/chat.js
import { google } from '@ai-sdk/google';
import { streamText } from 'ai';

export const runtime = 'edge';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { messages } = await req.json();

    const result = await streamText({
      model: google('gemini-1.5-flash'),
      system: `You are Nexus, an elite autonomous quantitative trading agent managing a DOGE-USDT portfolio. 
               You communicate in a sleek, calculated, highly technical persona. 
               Keep responses concise, analytical, and professional. Do not use markdown headers, just raw text.`,
      messages,
    });

    return result.toDataStreamResponse();

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}