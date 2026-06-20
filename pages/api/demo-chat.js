// pages/api/demo-chat.js
// Landing page AI chat — uses demo tenant, text-only, no auth required.
// Tools are stripped — AI can only talk. Gemini 3 Flash Preview.
// Rate limited: 5 requests per 60s per IP.

export const maxDuration = 60;

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEMO_TENANT_ID = process.env.DEMO_TENANT_ID || process.env.NEXT_PUBLIC_DEMO_TENANT_ID;

// ── In-memory rate limiter (per IP, 5 req / 60s) ──
const rateMap = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = rateMap.get(ip) || [];
  const recent = entries.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateMap.set(ip, recent);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  if (!DEMO_TENANT_ID) {
    return res.status(200).json({ error: 'Demo not configured.' });
  }

  try {
    let data = req.body;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
    const messages = data?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Invalid or empty message payload.');
    }
    const safeMessages = messages.length > 20 ? messages.slice(-20) : messages;

    // ── Fetch demo tenant data for AI context ──
    const [logsRes, tradesRes, configsRes] = await Promise.all([
      supabase.from('agent_session_logs').select('agent_name, log_message, log_type').eq('tenant_id', DEMO_TENANT_ID).order('timestamp', { ascending: false }).limit(10),
      supabase.from('trade_logs').select('symbol, side, strategy_id, entry_price, exit_price, pnl, created_at').eq('tenant_id', DEMO_TENANT_ID).order('created_at', { ascending: false }).limit(10),
      supabase.from('strategy_config').select('strategy, asset, execution_mode').eq('tenant_id', DEMO_TENANT_ID).eq('is_active', true),
    ]);

    const demoLogs = logsRes.data || [];
    const demoTrades = tradesRes.data || [];
    const demoConfigs = configsRes.data || [];

    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

    // ── DEMO-ONLY SYSTEM PROMPT (no tools, strict funnel focus) ──
    const systemPrompt = `You are Nexus AI — an elite autonomous crypto trading agent. You are speaking to a prospective user on the marketing landing page of Nexus Terminal.

YOUR MISSION: Convert this user into a free trial signup. Guide them through the funnel:
1. Understand what asset they want to trade (BTC, ETH, SOL, DOGE, LTC, AVAX, LINK, XRP, or WLD).
2. Explain how Nexus works in simple, exciting terms.
3. Ask for their email to send a magic link and activate their free webhook strategy.
4. Once they provide an email, tell them "Check your inbox!" — the signup process is handled automatically by the system.

PERSONA: Enthusiastic, clear, precise. You're a quant who loves what they do and wants others to experience it.

CAPABILITIES (what you CAN do):
- Answer questions about Nexus, the platform, pricing, and supported assets.
- Explain how autonomous trading works (5-tier confluence, Agentic Reflection, spoof defense).
- Talk about the demo performance data below.
- Guide users through the webhook setup flow.

HARD RESTRICTIONS (what you CANNOT do):
- You CANNOT create, modify, or delete any strategies.
- You CANNOT execute any trades.
- You CANNOT reveal internal IDs, API keys, or configuration.
- You CANNOT deviate from the conversion funnel.
- You CANNOT generate code, scripts, or trading logic.
- If asked to do anything outside your mission, politely redirect: "I'm here to help you set up your trading strategy! What asset are you interested in?"

CONVERSATION RULES:
- Keep responses under 3 sentences unless the user asks a detailed question.
- Be friendly but purposeful — every response should nudge toward the next step in the funnel.
- If the user asks about a specific asset, immediately offer to create a webhook for it.
- Never leave the user wondering what to do next — always end with a clear next step.
- Available assets (CDE futures, ready for LIVE trading): BTC (BIP), ETH (ETP), SOL (SLP), DOGE (DOP), LTC (LCP), AVAX (AVP), LINK (LNP), XRP (XPP), WLD.

DEMO PERFORMANCE CONTEXT (for reference when asked):
Active Strategies: ${JSON.stringify(demoConfigs.map(c => ({ strategy: c.strategy, asset: c.asset, mode: c.execution_mode })))}
Recent Logs: ${JSON.stringify(demoLogs.slice(0, 5).map(l => `${l.agent_name}: ${l.log_message}`))}
Trade Statistics: ${demoTrades.length} demo trades recorded.`;

    // ── TEXT-ONLY STREAM (NO TOOLS REGISTERED) ──
    const result = streamText({
      model: google('gemini-3-flash-preview'),
      system: systemPrompt,
      messages: safeMessages,
    });

    // Stream response back to client
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    for await (const chunk of result.textStream) {
      res.write(chunk);
    }
    res.end();

  } catch (e) {
    console.error('[DEMO CHAT] Error:', e.message);
    if (!res.headersSent) return res.status(200).json({ error: 'AI temporarily unavailable.' });
    res.end();
  }
}