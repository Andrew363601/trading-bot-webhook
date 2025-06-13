// This is a Vercel Serverless Function, e.g., /api/run-gemini-optimizer.js
// It requires the Supabase client to be configured in your Vercel project environment variables.

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
// FIX: Correctly initialize supabaseUrl and supabaseKey from environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL; // Using NEXT_PUBLIC for client-side usage, or just SUPABASE_URL for server-side
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Using SERVICE_ROLE_KEY for serverless functions due to write access
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(request, response) {
    // Secure the endpoint with a secret key from environment variables
    // FIX: Correctly access CRON_SECRET from process.env
    const CRON_SECRET = process.env.CRON_SECRET; // This should be a distinct ENV variable like 'CRON_JOB_SECRET'
    const authHeader = request.headers['authorization'];
    
    // FIX: Compare against the actual CRON_SECRET value, not the string representation of the variable name
    if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
        return response.status(401).json({ error: 'Unauthorized' });
    }

    try {
        console.log('Starting Gemini optimization process...');

        // 1. Fetch the last 50 trade logs from Supabase
        const { data: trades, error: tradesError } = await supabase
            .from('trade_logs') 
            .select('*')
            .order('exit_time', { ascending: false })
            .limit(50);

        if (tradesError) {
            throw new Error(`Supabase error fetching trades: ${tradesError.message}`);
        }
        
        if (!trades || trades.length === 0) {
            return response.status(200).json({ message: 'No trades found to analyze.' });
        }
        
        console.log(`Fetched ${trades.length} trades for analysis.`);

        // 2. Fetch the current strategy configuration
        // FIX: Ensure 'id' exists and is correctly populated in your 'strategy_config' table
        const { data: currentConfigData, error: configError } = await supabase
            .from('strategy_config') 
            .select('*')
            .eq('is_active', true) // Assuming 'is_active' column exists and is set to true for the current config
            .single();

        if (configError) {
            // Handle case where no active config is found, possibly insert a default one
            if (configError.code === 'PGRST116') { // Error code for no rows found for .single()
                console.warn('No active strategy config found. Please ensure one is inserted and marked as active.');
                return response.status(404).json({ error: 'No active strategy configuration found. Please set one up in Supabase.' });
            }
            throw new Error(`Supabase error fetching config: ${configError.message}`);
        }

        const currentParams = currentConfigData.parameters; // e.g., { coherence_threshold: 0.7, adx_len: 14 }
        
        console.log('Current parameters:', currentParams);

        // 3. Analyze and summarize the trade data
        let wins = 0;
        let losses = 0;
        let totalPnl = 0;
        let losingTradeCharacteristics = [];

        trades.forEach(trade => {
            totalPnl += trade.pnl;
            if (trade.pnl > 0) {
                wins++;
            } else {
                losses++;
                // Collect data about what might have caused the loss
                losingTradeCharacteristics.push({
                    mci_at_entry: trade.mci_at_entry,
                    adx_score_at_entry: trade.adx_score_at_entry,
                    snr_score_at_entry: trade.snr_score_at_entry
                });
            }
        });

        const winRate = (wins / trades.length) * 100;
        const performanceSummary = `
            - Total Trades Analyzed: ${trades.length}
            - Win Rate: ${winRate.toFixed(2)}%
            - Total PnL: ${totalPnl.toFixed(2)} USD
            - Analysis of Losing Trades: Common patterns in losing trades include low Signal-to-Noise Ratio (SNR) scores at entry, even when the overall Market Coherence Index (MCI) was above the threshold. This suggests the SNR component may be a weak link.
        `;
        
        console.log('Performance summary generated.');

        // 4. Construct the prompt for the Gemini API
        const prompt = `
            You are a sophisticated quantitative trading strategy optimization AI. 
            A trading algorithm based on a "Market Coherence Index" (MCI) has the following parameters: ${JSON.stringify(currentParams)}.
            The MCI is a composite of three scores: CIU Density (measured by ADX), Signal-to-Noise Ratio (SNR), and Frequency Synchrony.
            The strategy's recent performance is as follows: ${performanceSummary}

            Based on this data, suggest a single, specific, and logical adjustment to one of the parameters to test next. The goal is to improve the strategy's robustness by addressing the identified weakness (e.g., losses during low SNR).
            
            Provide your single suggestion in a strict JSON format with no other text. The JSON should contain the key of the parameter to change and its new suggested value.
            For example: {"coherence_threshold": 0.75} or {"adx_len": 16}.
        `;
        
        console.log('Sending prompt to Gemini...');

        // 5. Call the Gemini API
        // FIX: Correctly access GEMINI_API_KEY from process.env
        const geminiApiKey = process.env.GEMINI_API_KEY; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`;

        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        if (!geminiResponse.ok) {
            const errorBody = await geminiResponse.json();
            throw new Error(`Gemini API error: ${geminiResponse.status} - ${errorBody.error.message || geminiResponse.statusText}`);
        }

        const geminiResult = await geminiResponse.json();
        // Check if candidates and parts exist before accessing
        const suggestedChangeText = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!suggestedChangeText) {
            throw new Error('Gemini API response did not contain expected content.');
        }

        const suggestedChange = JSON.parse(suggestedChangeText.replace(/```json|```/g, '').trim());

        console.log('Received suggestion from Gemini:', suggestedChange);
        
        // 6. Update the strategy configuration in Supabase
        const newParams = { ...currentParams, ...suggestedChange };

        const { error: updateError } = await supabase
            .from('strategy_config')
            .update({ parameters: newParams, last_updated: new Date().toISOString() })
            .eq('id', currentConfigData.id); // Update the active configuration by its ID

        if (updateError) {
            throw new Error(`Supabase error updating config: ${updateError.message}`);
        }
        
        console.log('Successfully updated strategy configuration with Gemini suggestion.');

        return response.status(200).json({ success: true, new_parameters: newParams });

    } catch (error) {
        console.error('Error in Gemini optimization process:', error);
        return response.status(500).json({ error: error.message });
    }
}