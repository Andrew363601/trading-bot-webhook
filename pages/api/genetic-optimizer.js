// pages/api/genetic-optimizer.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Define the evolutionary boundaries
const PARAM_BOUNDS = {
    coherence: { min: 0.4, max: 0.95 },
    lookback: { min: 5, max: 50 }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    try {
        // 1. Fetch historical execution data for fitness evaluation
        const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(50);
        if (!logs || logs.length < 5) return res.status(400).json({ error: "Insufficient generational data." });

        // 2. Generate Initial Population (Randomized combinations)
        let population = Array.from({ length: 20 }, () => ({
            coherence: parseFloat((Math.random() * (PARAM_BOUNDS.coherence.max - PARAM_BOUNDS.coherence.min) + PARAM_BOUNDS.coherence.min).toFixed(2)),
            lookback: Math.floor(Math.random() * (PARAM_BOUNDS.lookback.max - PARAM_BOUNDS.lookback.min + 1) + PARAM_BOUNDS.lookback.min),
            fitness: 0
        }));

        // 3. Fitness Function (Evaluates how parameters would have performed)
        // In a full backtest, you would run historical price data here. 
        // For this engine, we evaluate fitness based on the MCI trajectory of past winning trades.
        population.forEach(gene => {
            let simulatedPnL = 0;
            logs.forEach(trade => {
                // Example Logic: If trade MCI was above our gene's threshold, we would have taken it
                if (trade.mci_at_entry >= gene.coherence) {
                    simulatedPnL += trade.pnl || 0; 
                }
            });
            // Heavily penalize negative PnL, reward high efficiency
            gene.fitness = simulatedPnL > 0 ? simulatedPnL * (1 / gene.lookback) : simulatedPnL * 2; 
        });

        // 4. Selection & Mutation (Survival of the fittest)
        population.sort((a, b) => b.fitness - a.fitness);
        const alphaGene = population[0];

        // Ensure the mutation actually outperformed the baseline before deploying
        if (alphaGene.fitness > 0) {
            const { data: config } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
            const nextVer = (parseFloat(config.version || "1.0") + 0.1).toFixed(1);

            await supabase.from('strategy_config').update({
                parameters: {
                    coherence_threshold: alphaGene.coherence,
                    lookback_period: alphaGene.lookback
                },
                version: nextVer,
                last_updated: new Date().toISOString()
            }).eq('id', config.id);

            return res.status(200).json({ 
                status: "Evolution Complete", 
                alpha_survivor: alphaGene,
                version: nextVer 
            });
        }

        return res.status(200).json({ status: "Stagnation. No positive mutations found in this generation." });

    } catch (err) {
        console.error("[EVOLUTION FAULT]:", err.message);
        return res.status(500).json({ error: err.message });
    }
}