// pages/api/genetic-optimizer.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Define Evolutionary Boundaries
const PARAM_BOUNDS = {
    coherence: { min: 0.4, max: 0.95 },
    lookback: { min: 5, max: 50 }
};

const GENERATIONS = 3;
const POPULATION_SIZE = 20;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    try {
        // 1. Fetch Market Reality
        const { data: logs } = await supabase.from('trade_logs').select('*').order('id', { ascending: false }).limit(50);
        if (!logs || logs.length < 5) return res.status(400).json({ error: "Insufficient generational data." });

        // Helper: The Fitness Test
        const evaluateFitness = (gene) => {
            let simulatedPnL = 0;
            logs.forEach(trade => {
                if (trade.mci_at_entry >= gene.coherence) {
                    simulatedPnL += trade.pnl || 0; 
                }
            });
            // Heavily penalize negative PnL, lightly reward efficiency
            return simulatedPnL > 0 ? simulatedPnL * (1 / (gene.lookback * 0.1)) : simulatedPnL * 2;
        };

        // 2. Genesis (Generation 0)
        let population = Array.from({ length: POPULATION_SIZE }, () => ({
            coherence: parseFloat((Math.random() * (PARAM_BOUNDS.coherence.max - PARAM_BOUNDS.coherence.min) + PARAM_BOUNDS.coherence.min).toFixed(2)),
            lookback: Math.floor(Math.random() * (PARAM_BOUNDS.lookback.max - PARAM_BOUNDS.lookback.min + 1) + PARAM_BOUNDS.lookback.min),
            fitness: 0
        }));

        let alphaGene = null;
        let evolutionHistory = [];

        // 3. The Evolutionary Loop
        for (let gen = 0; gen < GENERATIONS; gen++) {
            
            // Grade the current population
            population.forEach(gene => gene.fitness = evaluateFitness(gene));
            
            // Sort by fittest (descending)
            population.sort((a, b) => b.fitness - a.fitness);
            
            alphaGene = population[0];
            evolutionHistory.push({ 
                generation: gen, 
                top_fitness: alphaGene.fitness.toFixed(4), 
                top_coherence: alphaGene.coherence, 
                top_lookback: alphaGene.lookback 
            });

            // If we are on the final generation, break before breeding again
            if (gen === GENERATIONS - 1) break;

            // ELITISM: The top 4 parents survive into the next generation automatically
            const parents = population.slice(0, 4);
            let nextGeneration = [...parents]; 

            // CROSSOVER & MUTATION: Breed the children
            while (nextGeneration.length < POPULATION_SIZE) {
                // Select two random parents from the elite pool
                const parentA = parents[Math.floor(Math.random() * parents.length)];
                const parentB = parents[Math.floor(Math.random() * parents.length)];

                // Crossover: Take Coherence from A, Lookback from B
                let child = {
                    coherence: parentA.coherence,
                    lookback: parentB.lookback,
                    fitness: 0
                };

                // Mutation: 20% chance to genetically mutate the child to maintain diversity
                if (Math.random() < 0.20) {
                    const mutateCoherence = (Math.random() > 0.5 ? 0.05 : -0.05); // +/- 5% shift
                    child.coherence = Math.min(Math.max(child.coherence + mutateCoherence, PARAM_BOUNDS.coherence.min), PARAM_BOUNDS.coherence.max);
                    child.coherence = parseFloat(child.coherence.toFixed(2));
                    
                    const mutateLookback = (Math.random() > 0.5 ? 2 : -2); // +/- 2 periods
                    child.lookback = Math.min(Math.max(child.lookback + mutateLookback, PARAM_BOUNDS.lookback.min), PARAM_BOUNDS.lookback.max);
                }

                nextGeneration.push(child);
            }
            
            // Replace the old, weak generation with the newly bred super-generation
            population = nextGeneration;
        }

        // 4. Natural Selection / Deployment
        if (alphaGene && alphaGene.fitness > 0) {
            const { data: config } = await supabase.from('strategy_config').select('*').eq('is_active', true).single();
            const nextVer = (parseFloat(config.version || "1.0") + 0.1).toFixed(1);

            // Update the live system brain
            await supabase.from('strategy_config').update({
                parameters: {
                    coherence_threshold: alphaGene.coherence,
                    lookback_period: alphaGene.lookback
                },
                version: nextVer,
                last_updated: new Date().toISOString()
            }).eq('id', config.id);

            return res.status(200).json({ 
                status: "Multi-Generational Evolution Complete", 
                alpha_survivor: alphaGene,
                evolution_history: evolutionHistory,
                deployed_version: nextVer 
            });
        }

        return res.status(200).json({ 
            status: "Stagnation", 
            message: "All mutations died (No positive PnL found). Reverting to baseline.",
            evolution_history: evolutionHistory
        });

    } catch (err) {
        console.error("[EVOLUTION FAULT]:", err.message);
        return res.status(500).json({ error: err.message });
    }
}