import { createClient } from '@supabase/supabase-js';
import dns from 'node:dns';

// Force IPv4 for stable networking in Next.js backend
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

/**
 * R(ΨC) ULTRA-RESILIENT OPTIMIZER
 * ---------------------------------------------------------
 * Targets: gemini-1.5-flash (Highest stability for REST)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = process.env.GEMINI_API_KEY; 
  const cronSecret = process.env.CRON_SECRET || "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

  // --- TERMINAL DIAGNOSTIC ---
  console.log("--- NEXUS OPTIMIZER DIAGNOSTIC ---");
  console.log(`[SYS] Supabase URL: ${supabaseUrl ? 'OK' : 'MISSING'}`);
  console.log(`[SYS] Gemini Key Found: ${geminiKey ? 'YES (' + geminiKey.substring(0, 5) + '...)' : 'NO'}`);
  console.log("----------------------------------");

  // Auth Guard
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  if (!geminiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not found in server process. Restart your dev server." });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. Fetch History
    const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(20);
    const { data: current, error: currentErr } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();

    if (currentErr) throw new Error("Could not find active strategy.");
    const isColdStart = !logs || logs.length === 0;

    // 2. Intelligence Prompt
    const systemPrompt = `Act as an elite quantitative researcher. Optimize 'coherence_threshold' (0.5 to 0.85). Respond ONLY with valid JSON.`;
    const userQuery = `Strategy: ${JSON.stringify(current.parameters)}. History: ${isColdStart ? 'COLD START' : JSON.stringify(logs)}`;
    
    // 3. Call Gemini (Dual-Auth: Param + Header)
    // Using 1.5-flash as it is the most stable production endpoint for REST
    const model = "gemini-1.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    const aiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY // <-- This bypasses network stripping
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { 
            responseMimeType: "application/json", 
            temperature: 0.2 
        }
      })
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.json().catch(() => ({}));
      console.error("[GEMINI ERROR]", JSON.stringify(errBody));
      throw new Error(errBody.error?.message || `AI Gateway rejected request (${aiResponse.status})`);
    }

    const aiResult = await aiResponse.json();
    let aiText = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!aiText) throw new Error("AI returned an empty response.");

    // Clean and Parse
    const optimizedParams = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());
    const nextVer = (parseFloat(current.version || "1.0") + 0.1).toFixed(1);

    // 4. Update Database
    const { error: updateErr } = await supabase
      .from('strategy_config')
      .update({ 
        parameters: optimizedParams, 
        version: nextVer, 
        last_updated: new Date().toISOString() 
      })
      .eq('id', current.id);

    if (updateErr) throw updateErr;

    return res.status(200).json({ 
        message: `Nexus Actualized. Strategy shifted to v${nextVer}.`,
        parameters: optimizedParams 
    });

  } catch (err) {
    console.error("[OPTIMIZER FAULT]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}