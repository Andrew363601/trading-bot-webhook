import { createClient } from '@supabase/supabase-js';
import dns from 'node:dns';

// Force IPv4 for stable networking in cloud environments
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = process.env.GEMINI_API_KEY; 
  const cronSecret = process.env.CRON_SECRET || "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

  // Auth Guard
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  if (!geminiKey) return res.status(500).json({ error: "GEMINI_API_KEY not found in .env" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(20);
    const { data: current, error: currentErr } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();

    if (currentErr) throw new Error("Active strategy config not found.");

    // AI Logic Loop
    const systemPrompt = "Act as an elite quantitative researcher. Optimize 'coherence_threshold' (0.5 to 0.85). Respond ONLY with valid JSON.";
    const userQuery = `Strategy: ${JSON.stringify(current.parameters)}. History: ${logs.length === 0 ? 'COLD START' : JSON.stringify(logs)}`;
    
    // UPDATED MODEL AND ENDPOINT
    const model = "gemini-2.5-flash-preview-09-2025"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    const aiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      })
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.json().catch(() => ({}));
      throw new Error(`Gemini API Rejection: ${errBody.error?.message || aiResponse.statusText}`);
    }

    const aiResult = await aiResponse.json();
    let aiText = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;
    
    const optimizedParams = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());
    const nextVer = (parseFloat(current.version || "1.0") + 0.1).toFixed(1);

    await supabase
      .from('strategy_config')
      .update({ parameters: optimizedParams, version: nextVer, last_updated: new Date().toISOString() })
      .eq('id', current.id);

    return res.status(200).json({ 
        message: `Nexus Actualized to v${nextVer}.`,
        parameters: optimizedParams 
    });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}