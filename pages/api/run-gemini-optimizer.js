import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send("Use POST");

  // Auth Guard (Cron Secret)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // 1. Fetch the last 20 trade logs to analyze performance
    const { data: logs, error: logError } = await supabase
      .from('trade_logs')
      .select('*')
      .order('id', { ascending: false })
      .limit(20);

    if (logError || !logs.length) throw new Error("Insufficient trade data for optimization.");

    // 2. Fetch current strategy config
    const { data: currentStrategy } = await supabase
      .from('strategy_config')
      .select('*')
      .eq('is_active', true)
      .single();

    // 3. Prepare Prompt for Gemini
    const systemPrompt = `You are an institutional quant researcher specializing in Coherence-based trading. 
    Analyze the provided trade logs and the current strategy parameters. 
    Your goal is to optimize the 'coherence_threshold' and 'vol_spike_mult' to increase PnL.
    If PnL is negative, be more conservative (increase thresholds).
    If PnL is positive, stay stable or slightly tighten to capture cleaner moves.
    Respond ONLY with a valid JSON object containing the new parameters.`;

    const userQuery = `Current Strategy: ${JSON.stringify(currentStrategy.parameters)}
    Recent Trade Logs: ${JSON.stringify(logs)}
    Generate the optimized JSON for the 'parameters' column.`;

    // 4. Call Gemini 2.5 Flash
    const apiKey = ""; // Canvas provides this automatically
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const geminiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    const result = await geminiResponse.json();
    const optimizedParams = JSON.parse(result.candidates[0].content.parts[0].text);

    // 5. Update Supabase with the new "Optimized" state
    const { error: updateError } = await supabase
      .from('strategy_config')
      .update({ 
        parameters: optimizedParams,
        version: (parseFloat(currentStrategy.version) + 0.1).toFixed(1),
        last_updated: new Date().toISOString()
      })
      .eq('id', currentStrategy.id);

    if (updateError) throw updateError;

    return res.status(200).json({ 
      message: "R(ΨC) Loop Complete. Strategy Updated.",
      new_params: optimizedParams 
    });

  } catch (err) {
    console.error("Optimizer Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}