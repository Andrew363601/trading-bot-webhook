// /pages/api/webhook.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
 process.env.NEXT_PUBLIC_SUPABASE_URL,
 process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
 if (req.method === 'POST') {
   try {
     const body = req.body;
     // Expecting detailed trade data from Pine Script
     const { 
         symbol, 
         side, 
         price, 
         strategy: pineStrategy, // Renamed to avoid conflict with active.strategy
         version: pineVersion,  // Renamed to avoid conflict with active.version
         pnl, 
         exit_time, 
         mci_at_entry, 
         adx_score_at_entry, 
         snr_score_at_entry,
         entry_price,
         exit_price
     } = body;

     // --- Optional: Fetch and compare against currently active strategy ---
     // This ensures only trades from the active strategy are logged for optimization.
     const { data: activeStrategy, error: activeError } = await supabase
       .from("strategy_config") // Using the new strategy_config table
       .select("parameters") // We only need parameters for comparison if logging
       .eq("is_active", true)
       .single();

     if (activeError || !activeStrategy) {
       // If no active strategy, log it as an alert, but don't prevent logging to trade_logs
       console.warn("No active strategy found in 'strategy_config'. Logging trade anyway.");
       // return res.status(500).json({ error: "No active strategy found in 'strategy_config'" }); // Uncomment to strictly enforce active strategy
     } else {
        // You might want to compare specific parameters if your Pine Script sends them.
        // For example, if your Pine Script sends the coherence_threshold it's using:
        // if (mci_at_entry !== activeStrategy.parameters.coherence_threshold) {
        //     console.warn("Alert does not match active strategy's current coherence_threshold. Logging anyway.");
        // }
     }
     // --- End Optional Active Strategy Check ---


     // 1. Insert into trade_logs table for Gemini's R(ΨC) feedback loop
     const { error: tradeLogInsertError } = await supabase.from('trade_logs').insert([
       {
         pnl: pnl,
         exit_time: exit_time,
         mci_at_entry: mci_at_entry,
         adx_score_at_entry: adx_score_at_entry,
         snr_score_at_entry: snr_score_at_entry,
         entry_price: entry_price,
         exit_price: exit_price,
         trade_type: side, // 'Long' or 'Short'
         // You can add more fields here if your Pine Script sends them
         // e.g., symbol: symbol, strategy_name: pineStrategy, strategy_version: pineVersion
       }
     ]);

     if (tradeLogInsertError) {
       console.error("❌ Supabase trade_logs Insert Error:", tradeLogInsertError.message);
       return res.status(500).json({ error: tradeLogInsertError.message });
     }

     // Optional: You can still log to the 'alerts' table if you use it for other purposes
     // For this, ensure 'strategy' and 'version' are passed explicitly if you need them.
     const { error: alertsInsertError } = await supabase.from("alerts").insert([
       {
         symbol: symbol,
         side: side,
         price: price,
         strategy: pineStrategy, // Original strategy name from Pine Script
         version: pineVersion,  // Original version from Pine Script
         raw: req.body // Store the full raw payload for debugging
       }
     ]);

     if (alertsInsertError) {
       console.error("❌ Supabase Alerts Insert Error:", alertsInsertError.message);
       // Don't necessarily return error here, as trade_logs might have succeeded
     }

     return res.status(200).json({ message: "✅ Trade logged and alert stored in Supabase" });

   } catch (err) {
     console.error("❌ Webhook Handler Crash:", err.message);
     return res.status(500).json({ error: "Internal Server Error" });
   }
 }

 if (req.method === 'GET') {
   return res.status(200).send("👋 Webhook is working! Send POST requests.");
 }

 return res.status(405).send("Method Not Allowed");
}
